import { randomUUID } from "node:crypto";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Message, ModelThinkingLevel, Models } from "@earendil-works/pi-ai";

import type { LoggerPort } from "../../../../observability/ports/logger-port";
import type {
	AgentModel,
	AgentRunFailureReason,
	AgentRuntimePort,
	AgentRuntimeStatus,
	AgentSession,
	AgentSessionSpec,
	ThinkingLevel,
	UsageSnapshot,
} from "../../../ports/outbound/agent-session-port";
import { PiAgentSession, resolveModel } from "./pi-agent-session";
import type { HarnessToolSet, PiCompactionSettings } from "./pi-agent-session";
import { toPiAgentTool } from "./pi-tool-adapter";
import { pruneTranscripts, TranscriptWriter, transcriptFilePath } from "./pi-transcript";

export type PiAgentRuntimeOptions = Readonly<{
	models: Models;
	transcriptDir: string;
	retryDelaysMs: readonly number[];
	requestTimeoutMs: number;
	compaction: PiCompactionSettings;
	createHarnessTools(spec: AgentSessionSpec, context: HarnessToolContext): HarnessToolSet;
	hasCredentials(): boolean;
	logger: LoggerPort;
	now(): Date;
}>;

// 汎用ツールはセッションより先に作るため、セッションの履歴は呼び出し時に引く。
export type HarnessToolContext = Readonly<{
	sessionId: string;
	conversation: () => readonly Message[];
}>;

export class PiAgentRuntime implements AgentRuntimePort {
	readonly #options: PiAgentRuntimeOptions;
	readonly #sessions = new Map<string, PiAgentSession>();

	#authFailed = false;
	#lastFailure: { at: string; message: string } | null = null;
	#usage: UsageSnapshot | null = null;

	constructor(options: PiAgentRuntimeOptions) {
		this.#options = options;
	}

	open(spec: AgentSessionSpec): AgentSession {
		// 存在しないモデルで汎用ツールを作らないよう、先に解決しておく。
		resolveModel(this.#options.models, spec.model);
		const id = randomUUID();
		let opened: PiAgentSession | undefined;
		const harness = this.#options.createHarnessTools(spec, {
			sessionId: id,
			conversation: () => opened?.llmMessages() ?? [],
		});
		const tools = [...spec.tools.map(toPiAgentTool), ...harness.tools];
		const duplicated = findDuplicatedName(tools.map((tool) => tool.name));
		if (duplicated !== undefined) {
			void harness.dispose().catch((error: unknown) => {
				this.#options.logger.error("agent.pi.harness_dispose_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			throw new Error(`Duplicated agent tool name: ${duplicated}`);
		}

		const session = new PiAgentSession({
			id,
			spec,
			tools,
			harness,
			models: this.#options.models,
			retryDelaysMs: this.#options.retryDelaysMs,
			requestTimeoutMs: this.#options.requestTimeoutMs,
			compaction: this.#options.compaction,
			transcript: new TranscriptWriter({
				filePath: transcriptFilePath(this.#options.transcriptDir, this.#options.now(), id),
				logger: this.#options.logger,
				sessionId: id,
			}),
			logger: this.#options.logger,
			now: this.#options.now,
			onRunCompleted: () => {
				this.#authFailed = false;
			},
			onRunFailed: (reason, message) => {
				this.#recordFailure(reason, message);
			},
			onClosed: (sessionId) => {
				this.#sessions.delete(sessionId);
			},
		});
		opened = session;
		this.#sessions.set(id, session);
		return session;
	}

	listModels(): readonly AgentModel[] {
		return this.#options.models.getModels().map((model) => ({
			provider: model.provider,
			model: model.id,
			displayName: model.name,
			supportedThinkingLevels: getSupportedThinkingLevels(model).filter(isLunaThinkingLevel),
		}));
	}

	status(): AgentRuntimeStatus {
		return {
			auth: !this.#options.hasCredentials()
				? "missing"
				: this.#authFailed
					? "auth_required"
					: "ready",
			usage: this.#usage,
			lastFailure: this.#lastFailure,
			sessions: [...this.#sessions.values()].map((session) => session.status()),
		};
	}

	setUsage(usage: UsageSnapshot): void {
		this.#usage = usage;
	}

	// 再ログインの直後に、次の run を待たずに認証済みの表示へ戻すため。
	clearAuthFailure(): void {
		this.#authFailed = false;
	}

	pruneTranscripts(now: Date, retentionMs: number): Promise<number> {
		return pruneTranscripts(this.#options.transcriptDir, now, retentionMs);
	}

	#recordFailure(reason: AgentRunFailureReason, message: string): void {
		this.#lastFailure = { at: this.#options.now().toISOString(), message };
		if (reason === "auth_required") {
			this.#authFailed = true;
		}
	}
}

function isLunaThinkingLevel(level: ModelThinkingLevel): level is ThinkingLevel {
	return level !== "max";
}

function findDuplicatedName(names: readonly string[]): string | undefined {
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) {
			return name;
		}
		seen.add(name);
	}
	return undefined;
}
