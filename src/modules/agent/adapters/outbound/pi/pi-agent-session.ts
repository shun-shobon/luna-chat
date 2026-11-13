import { Agent } from "@earendil-works/pi-agent-core";
import type {
	AgentEvent,
	AgentMessage,
	AgentRequestUpdate,
	AgentTool as PiAgentTool,
	PrepareRequestContext,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { Api, Message, Model, Models } from "@earendil-works/pi-ai";
import { generateSummaryWithUsage, shouldCompact } from "@earendil-works/pi-coding-agent";

import type { LoggerPort } from "../../../../observability/ports/logger-port";
import type {
	AgentInputMessage,
	AgentRunFailureReason,
	AgentRunResult,
	AgentSession,
	AgentSessionPhase,
	AgentSessionSpec,
	AgentSessionStatus,
	ModelSelection,
} from "../../../ports/outbound/agent-session-port";
import { createLunaInputMessage, toLlmMessages } from "./luna-input-message";
import {
	applyCompaction,
	createCompactionState,
	findLastPromptUsage,
	selectSummarizationTarget,
} from "./pi-compaction";
import type { CompactionState } from "./pi-compaction";
import {
	classifyAgentError,
	EMPTY_REQUEST_FAILURE_SIGNALS,
	parseProviderErrorEvent,
} from "./pi-error-classification";
import type { RequestFailureSignals } from "./pi-error-classification";
import type { TranscriptWriter } from "./pi-transcript";

export type PiCompactionSettings = Readonly<{
	model: ModelSelection;
	reserveTokens: number;
	keepRecentTokens: number;
}>;

// pi は引数をスキーマで検証してから execute へ渡すため、ツールごとの引数型を混ぜて持てる AgentTool<any> で受ける（pi-agent-core の AgentState.tools と同じ）。
export type AnyPiAgentTool = PiAgentTool<any>;

export type HarnessToolSet = Readonly<{
	tools: readonly AnyPiAgentTool[];
	dispose(): Promise<void>;
}>;

export class SessionClosedError extends Error {
	constructor(sessionId: string) {
		super(`Agent session is closed: ${sessionId}`);
		this.name = "SessionClosedError";
	}
}

export class SessionBusyError extends Error {
	constructor(sessionId: string) {
		super(`Agent session is already running: ${sessionId}`);
		this.name = "SessionBusyError";
	}
}

export function resolveModel(models: Models, selection: ModelSelection): Model<Api> {
	const model = models.getModel(selection.provider, selection.model);
	if (model === undefined) {
		throw new Error(`Unknown model: ${selection.provider}/${selection.model}`);
	}
	return model;
}

export type PiAgentSessionInput = Readonly<{
	id: string;
	spec: AgentSessionSpec;
	tools: readonly AnyPiAgentTool[];
	harness: HarnessToolSet;
	models: Models;
	retryDelaysMs: readonly number[];
	requestTimeoutMs: number;
	compaction: PiCompactionSettings;
	transcript: TranscriptWriter;
	logger: LoggerPort;
	now(): Date;
	onRunCompleted(): void;
	onRunFailed(reason: AgentRunFailureReason, message: string): void;
	onClosed(sessionId: string): void;
}>;

export class PiAgentSession implements AgentSession {
	readonly id: string;
	readonly #agent: Agent;
	readonly #compactionSettings: PiCompactionSettings;
	readonly #harness: HarnessToolSet;
	readonly #input: PiAgentSessionInput;
	readonly #logger: LoggerPort;
	readonly #models: Models;
	readonly #spec: AgentSessionSpec;
	readonly #transcript: TranscriptWriter;

	#abortRequested = false;
	#closed = false;
	#compaction: CompactionState | undefined;
	// 要約した後も直前の assistant の usage は大きいままなので、同じ usage で二度要約しないよう覚えておく。
	#compactionCheckedUsage: AgentMessage | undefined;
	#modelSelection: ModelSelection;
	#phase: AgentSessionPhase = "idle";
	#phaseSince: string;
	#retries = 0;
	#retryWait: { cancel(): void } | undefined;
	#runSettled: Promise<void> | undefined;
	#running = false;
	#signals: RequestFailureSignals = EMPTY_REQUEST_FAILURE_SIGNALS;

	constructor(input: PiAgentSessionInput) {
		this.id = input.id;
		this.#input = input;
		this.#compactionSettings = input.compaction;
		this.#harness = input.harness;
		this.#logger = input.logger;
		this.#models = input.models;
		this.#spec = input.spec;
		this.#transcript = input.transcript;
		this.#modelSelection = input.spec.model;
		this.#phaseSince = input.now().toISOString();

		this.#agent = new Agent({
			initialState: {
				systemPrompt: input.spec.systemPrompt,
				model: resolveModel(input.models, input.spec.model),
				thinkingLevel: input.spec.model.thinking,
				tools: [...input.tools],
			},
			convertToLlm: toLlmMessages,
			transformContext: (messages) => Promise.resolve(this.#transformContext(messages)),
			streamFn: this.#streamFn,
			prepareRequest: (request, signal) => this.#prepareRequest(request, signal),
			steeringMode: "all",
			followUpMode: "all",
			// openai-codex では prompt_cache_key と WebSocket の接続キーを兼ねるため、セッションの間は変えない。
			sessionId: input.id,
		});
		this.#agent.subscribe((event) => {
			this.#recordEvent(event);
		});

		this.#transcript.append({
			type: "session_open",
			at: this.#phaseSince,
			sessionId: this.id,
			kind: input.spec.kind,
			label: input.spec.label,
			model: input.spec.model,
		});
		// 先頭の system には message_end が出ないため、開いた時点で書く。
		for (const message of this.#agent.state.messages) {
			this.#transcript.append({ type: "message", at: this.#phaseSince, message });
		}
	}

	async run(messages: readonly AgentInputMessage[]): Promise<AgentRunResult> {
		this.#assertOpen();
		if (this.#running) {
			throw new SessionBusyError(this.id);
		}
		this.#running = true;
		const settled = Promise.withResolvers<void>();
		this.#runSettled = settled.promise;
		try {
			return await this.#execute(messages);
		} finally {
			this.#running = false;
			if (!this.#closed) {
				this.#setPhase("idle");
			}
			settled.resolve();
		}
	}

	steer(message: AgentInputMessage): void {
		this.#assertOpen();
		this.#agent.steer(createLunaInputMessage(message, this.#input.now().getTime()));
	}

	// web_run と image_gen が直近の会話を参照するため、LLMへ送る形の履歴を返す。
	llmMessages(): Message[] {
		return toLlmMessages(this.#agent.state.messages);
	}

	async abort(): Promise<void> {
		if (!this.#running) {
			return;
		}
		this.#abortRequested = true;
		this.#retryWait?.cancel();
		this.#agent.abort();
		await this.#runSettled;
	}

	setModel(selection: ModelSelection): void {
		this.#assertOpen();
		const model = resolveModel(this.#models, selection);
		// 実行中でも次のリクエストから効くよう、prepareRequest で state の値を毎回渡している。
		this.#agent.state.model = model;
		this.#agent.state.thinkingLevel = selection.thinking;
		this.#modelSelection = selection;
		this.#transcript.append({
			type: "model_change",
			at: this.#input.now().toISOString(),
			model: selection,
		});
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		await this.abort();
		this.#setPhase("closed");
		cleanupSessionResources(this.id);
		try {
			await this.#transcript.flush();
			await this.#harness.dispose();
		} finally {
			this.#input.onClosed(this.id);
		}
	}

	status(): AgentSessionStatus {
		return {
			id: this.id,
			kind: this.#spec.kind,
			label: this.#spec.label,
			model: this.#modelSelection,
			phase: this.#phase,
			phaseSince: this.#phaseSince,
			retries: this.#retries,
		};
	}

	async #execute(messages: readonly AgentInputMessage[]): Promise<AgentRunResult> {
		this.#abortRequested = false;
		this.#retries = 0;
		this.#signals = EMPTY_REQUEST_FAILURE_SIGNALS;
		this.#setPhase("running");

		const timestamp = this.#input.now().getTime();
		await this.#agent.prompt(messages.map((message) => createLunaInputMessage(message, timestamp)));

		let transientAttempts = 0;
		for (;;) {
			const last = this.#agent.state.messages.at(-1);
			if (
				this.#isAbortRequested() ||
				(last?.role === "assistant" && last.stopReason === "aborted")
			) {
				return { status: "aborted" };
			}
			if (last?.role !== "assistant" || last.stopReason !== "error") {
				// 最後のリクエストの後に steer されたものはキューに残るので、この run の中で続けて処理する。
				if (this.#agent.hasQueuedMessages()) {
					await this.#agent.continue();
					continue;
				}
				this.#input.onRunCompleted();
				return { status: "completed", finalText: extractFinalText(last) };
			}

			const errorMessage = last.errorMessage ?? "unknown error";
			const kind = classifyAgentError(last, this.#signals);
			if (kind !== "transient") {
				return this.#fail(kind, errorMessage);
			}
			const delayMs = this.#input.retryDelaysMs[transientAttempts];
			if (delayMs === undefined) {
				return this.#fail("transient_exhausted", errorMessage);
			}
			transientAttempts += 1;
			this.#retries += 1;
			this.#logger.log("warn", "agent.pi.retry_scheduled", undefined, {
				attempt: transientAttempts,
				delayMs,
				error: errorMessage,
				sessionId: this.id,
			});
			if (!(await this.#waitForRetry(delayMs))) {
				return { status: "aborted" };
			}
			// error の assistant を残したまま continue すると、最後が assistant なので pi が受け付けない。
			this.#agent.state.messages = this.#agent.state.messages.slice(
				0,
				this.#agent.state.messages.lastIndexOf(last),
			);
			this.#signals = EMPTY_REQUEST_FAILURE_SIGNALS;
			this.#setPhase("running");
			await this.#agent.continue();
		}
	}

	#fail(reason: AgentRunFailureReason, message: string): AgentRunResult {
		this.#logger.log("warn", "agent.pi.run_failed", undefined, {
			error: message,
			reason,
			sessionId: this.id,
		});
		this.#input.onRunFailed(reason, message);
		return { status: "failed", reason, message };
	}

	#waitForRetry(delayMs: number): Promise<boolean> {
		if (this.#abortRequested) {
			return Promise.resolve(false);
		}
		this.#setPhase("retry_wait");
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.#retryWait = undefined;
				resolve(true);
			}, delayMs);
			this.#retryWait = {
				cancel: () => {
					clearTimeout(timer);
					this.#retryWait = undefined;
					resolve(false);
				},
			};
		});
	}

	readonly #streamFn: StreamFn = (model, context, options) => {
		this.#signals = EMPTY_REQUEST_FAILURE_SIGNALS;
		return this.#models.streamSimple(model, context, {
			...options,
			timeoutMs: this.#input.requestTimeoutMs,
			// 再試行はこのセッションが待機時間の列に従って行う。pi-ai 側でも重ねると待ち時間が読めなくなる。
			maxRetries: 0,
			onResponse: async (response, responseModel) => {
				this.#signals = { ...this.#signals, httpStatus: response.status };
				await options?.onResponse?.(response, responseModel);
			},
			onProviderStreamEvent: async (raw, eventModel) => {
				const event = parseProviderErrorEvent(raw);
				if (event !== undefined) {
					this.#signals = {
						...this.#signals,
						providerErrorStatus: event.status ?? this.#signals.providerErrorStatus,
						providerErrorCode: event.code ?? this.#signals.providerErrorCode,
					};
				}
				await options?.onProviderStreamEvent?.(raw, eventModel);
			},
		});
	};

	async #prepareRequest(
		request: PrepareRequestContext,
		signal: AbortSignal | undefined,
	): Promise<AgentRequestUpdate> {
		await this.#compactIfNeeded(request.context.messages, signal);
		return { model: this.#agent.state.model, thinkingLevel: this.#agent.state.thinkingLevel };
	}

	// 要約もリクエストを1回投げるので、失敗を run のエラーとして分類・再試行できるよう prepareRequest で行う。
	// transformContext は送るたびに呼ばれるため、そこでは保持した結果で置き換えるだけにする。
	async #compactIfNeeded(
		messages: readonly AgentMessage[],
		signal: AbortSignal | undefined,
	): Promise<void> {
		const usage = findLastPromptUsage(messages);
		if (usage === undefined) {
			return;
		}
		const usageMessage = messages[usage.index];
		const model = this.#agent.state.model;
		const settings = {
			enabled: true,
			reserveTokens: this.#compactionSettings.reserveTokens,
			keepRecentTokens: this.#compactionSettings.keepRecentTokens,
		};
		if (
			usageMessage === this.#compactionCheckedUsage ||
			!shouldCompact(usage.tokens, model.contextWindow, settings)
		) {
			return;
		}
		const target = selectSummarizationTarget(messages, this.#compaction, settings.keepRecentTokens);
		const firstKeptMessage = target === undefined ? undefined : messages[target.cutIndex];
		if (target === undefined || firstKeptMessage === undefined) {
			this.#compactionCheckedUsage = usageMessage;
			this.#logger.log("warn", "agent.pi.compaction_skipped", undefined, {
				sessionId: this.id,
				tokens: usage.tokens,
			});
			return;
		}

		this.#setPhase("compacting");
		try {
			const summaryModel = resolveModel(this.#models, this.#compactionSettings.model);
			const { text } = await generateSummaryWithUsage(
				target.messages,
				summaryModel,
				settings.reserveTokens,
				undefined,
				undefined,
				signal,
				undefined,
				this.#compaction?.summary,
				this.#compactionSettings.model.thinking,
				this.#streamFn,
			);
			const at = this.#input.now();
			this.#compaction = createCompactionState(firstKeptMessage, text, at.getTime());
			this.#compactionCheckedUsage = usageMessage;
			this.#transcript.append({
				type: "compaction",
				at: at.toISOString(),
				firstKeptIndex: target.cutIndex,
				tokensBefore: usage.tokens,
				summary: text,
			});
			this.#logger.log("info", "agent.pi.compaction_completed", undefined, {
				firstKeptIndex: target.cutIndex,
				sessionId: this.id,
				tokensBefore: usage.tokens,
			});
		} finally {
			this.#setPhase("running");
		}
	}

	#transformContext(messages: AgentMessage[]): AgentMessage[] {
		if (this.#compaction === undefined) {
			return messages;
		}
		const compacted = applyCompaction(messages, this.#compaction);
		if (compacted === undefined) {
			// 記録から消すのは末尾の error だけで、切り口には選ばれないため起きないはず。
			throw new Error(`Compaction cut point is missing from the transcript: ${this.id}`);
		}
		return compacted;
	}

	#recordEvent(event: AgentEvent): void {
		if (event.type === "message_end") {
			this.#transcript.append({
				type: "message",
				at: this.#input.now().toISOString(),
				message: event.message,
			});
		}
	}

	#setPhase(phase: AgentSessionPhase): void {
		if (this.#phase === phase) {
			return;
		}
		this.#phase = phase;
		this.#phaseSince = this.#input.now().toISOString();
	}

	// await をまたいで abort() が書き換えるため、フィールドを直接読むと型の絞り込みで常に false と扱われる。
	#isAbortRequested(): boolean {
		return this.#abortRequested;
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new SessionClosedError(this.id);
		}
	}
}

function extractFinalText(message: AgentMessage | undefined): string | null {
	if (message?.role !== "assistant") {
		return null;
	}
	const text = message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
	return text === "" ? null : text;
}
