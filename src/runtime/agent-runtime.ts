import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import type { Models, Provider } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import { ChatGptBackend } from "../modules/agent/adapters/outbound/pi/chatgpt-backend";
import { claudeCodeProvider } from "../modules/agent/adapters/outbound/pi/claude-code/provider";
import { FileCredentialStore } from "../modules/agent/adapters/outbound/pi/file-credential-store";
import { createImageGenTool } from "../modules/agent/adapters/outbound/pi/image-gen-tool";
import { PiAgentRuntime } from "../modules/agent/adapters/outbound/pi/pi-agent-runtime";
import type { HarnessToolContext } from "../modules/agent/adapters/outbound/pi/pi-agent-runtime";
import type {
	AnyPiAgentTool,
	HarnessBackground,
	HarnessToolSet,
} from "../modules/agent/adapters/outbound/pi/pi-agent-session";
import { toPiAgentTool } from "../modules/agent/adapters/outbound/pi/pi-tool-adapter";
import { createShellTools } from "../modules/agent/adapters/outbound/pi/shell-tools";
import { createWebRunTool } from "../modules/agent/adapters/outbound/pi/web-run-tool";
import type {
	AgentSessionSpec,
	HarnessToolName,
	ModelSelection,
} from "../modules/agent/ports/outbound/agent-session-port";
import type { LoggerPort } from "../modules/observability/ports/logger-port";
import type { WorkerCatalog, WorkerChoice } from "../modules/task/domain/task";
import { findSkillNames } from "../modules/workspace/adapters/skill-usage-store";
import type { SkillUsageStore } from "../modules/workspace/adapters/skill-usage-store";
import type { WorkerSetting, WorkspaceConfig } from "../modules/workspace/domain/workspace-config";

export const TURN_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 180_000];
const COMPACTION_RESERVE_TOKENS = 16_384;
const COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const BACKEND_TIMEOUT_MS = 120_000;
const WEB_RUN_MAX_OUTPUT_TOKENS = 10_000;

export function credentialsPath(lunaHomeDir: string): string {
	return resolve(lunaHomeDir, "auth", "credentials.json");
}

function claudeCodeConfigDir(lunaHomeDir: string): string {
	return resolve(lunaHomeDir, "claude-code");
}

export function createAgentModels(lunaHomeDir: string): Models {
	const models = createModels({
		credentials: new FileCredentialStore(credentialsPath(lunaHomeDir)),
	});
	models.setProvider(withGpt62Models(openaiCodexProvider()));
	models.setProvider(claudeCodeProvider({ configDir: claudeCodeConfigDir(lunaHomeDir) }));
	return models;
}

// pi-ai 1.5.2 の一覧にまだ無い。上流（earendil-works/pi cead615）の定義に合わせて前の世代を写す。6.2 入りの pi-ai へ上げたら消す。
function withGpt62Models(
	provider: Provider<"openai-codex-responses">,
): Provider<"openai-codex-responses"> {
	const findModel = (id: string) => {
		const model = provider.getModels().find((candidate) => candidate.id === id);
		if (model === undefined) {
			throw new Error(`openai-codex/${id} is missing from pi-ai`);
		}
		return model;
	};
	const added = [
		{ ...findModel("gpt-6.1-sol"), id: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
		{
			...findModel("gpt-6-astra"),
			id: "gpt-6.2-astra",
			name: "GPT-6.2 Astra",
			cost: {
				input: 8,
				output: 40,
				cacheRead: 0.4,
				cacheWrite: 10,
				tiers: [
					{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 },
				],
			},
		},
	];
	return {
		...provider,
		getModels: () => [...provider.getModels(), ...added],
		getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()), ...added],
	};
}

export function workerCatalogOf(setting: WorkerSetting): WorkerCatalog {
	const choices = Object.entries(setting.choices).map(
		([name, { description, ...model }]): WorkerChoice => ({ name, description, model }),
	);
	const [first, ...rest] = choices;
	if (first === undefined) throw new Error("models.worker.choices must not be empty");
	return { defaultName: setting.default, choices: [first, ...rest] };
}

// 起動時の検証で、設定のどの項目が不正かをキーの名前で示す。
export function modelSelectionsOf(
	models: WorkspaceConfig["models"],
): Readonly<Record<string, ModelSelection>> {
	const { worker, ...fixed } = models;
	return {
		...fixed,
		...Object.fromEntries(
			workerCatalogOf(worker).choices.map((choice) => [
				`worker.choices.${choice.name}`,
				choice.model,
			]),
		),
	};
}

export function validateModelSelections(
	runtime: Pick<PiAgentRuntime, "listModels">,
	selections: Readonly<Record<string, ModelSelection>>,
): void {
	const catalog = runtime.listModels();
	for (const [name, selection] of Object.entries(selections)) {
		const model = catalog.find(
			(candidate) =>
				candidate.provider === selection.provider && candidate.model === selection.model,
		);
		if (model === undefined) {
			throw new Error(`models.${name}: unknown model ${selection.provider}/${selection.model}`);
		}
		if (!model.supportedThinkingLevels.includes(selection.thinking)) {
			throw new Error(
				`models.${name}: ${selection.provider}/${selection.model} does not support thinking ${selection.thinking}`,
			);
		}
	}
}

export function createPiAgentRuntime(input: {
	backend: ChatGptBackend;
	compactionModel: ModelSelection;
	lunaHomeDir: string;
	logger: LoggerPort;
	models: Models;
	parentEnvironment: NodeJS.ProcessEnv;
	requestTimeoutMs: number;
	skillUsage: SkillUsageStore;
}): PiAgentRuntime {
	const recordSkillUse = (names: readonly string[]): void => {
		input.skillUsage.record(names, new Date()).catch((error: unknown) => {
			input.logger.error("workspace.skill_usage_write_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};
	const childEnvironment = withoutSecrets(input.parentEnvironment);
	return new PiAgentRuntime({
		models: input.models,
		transcriptDir: resolve(input.lunaHomeDir, "sessions"),
		scratchRoot: resolve(tmpdir(), "luna"),
		retryDelaysMs: TURN_RETRY_DELAYS_MS,
		requestTimeoutMs: input.requestTimeoutMs,
		compaction: {
			model: input.compactionModel,
			reserveTokens: COMPACTION_RESERVE_TOKENS,
			keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
		},
		createHarnessTools: (spec, context) =>
			createHarnessTools(spec, context, input.backend, childEnvironment, recordSkillUse),
		hasCredentials: () => existsSync(credentialsPath(input.lunaHomeDir)),
		logger: input.logger,
		now: () => new Date(),
	});
}

export function createChatGptBackend(models: Models): ChatGptBackend {
	return new ChatGptBackend({ models, timeoutMs: BACKEND_TIMEOUT_MS });
}

function createHarnessTools(
	spec: AgentSessionSpec,
	context: HarnessToolContext,
	backend: ChatGptBackend,
	environment: Readonly<Record<string, string | undefined>>,
	recordSkillUse: (names: readonly string[]) => void,
): HarnessToolSet {
	const wanted = new Set<HarnessToolName>(spec.harnessTools);
	const shell =
		wanted.has("exec_command") || wanted.has("write_stdin") || wanted.has("stop_background")
			? createShellTools({
					cwd: spec.cwd,
					env: { ...environment, TMPDIR: context.scratchDir },
					scratchDir: context.scratchDir,
					background: context.background,
				})
			: undefined;
	const read = createReadTool(spec.cwd);
	const candidates: ReadonlyArray<readonly [HarnessToolName, AnyPiAgentTool]> = [
		...(shell?.tools ?? []).flatMap((tool): Array<readonly [HarnessToolName, AnyPiAgentTool]> =>
			tool.name === "exec_command" || tool.name === "write_stdin" || tool.name === "stop_background"
				? [[tool.name, toPiAgentTool(tool)]]
				: [],
		),
		["read", read],
		["edit", createEditTool(spec.cwd)],
		["write", createWriteTool(spec.cwd)],
		["view_image", createViewImageTool(read)],
		[
			"web_run",
			toPiAgentTool(
				createWebRunTool({
					backend,
					sessionId: context.sessionId,
					model: spec.model.model,
					maxOutputTokens: WEB_RUN_MAX_OUTPUT_TOKENS,
					conversation: context.conversation,
				}),
			),
		],
		[
			"image_gen",
			toPiAgentTool(
				createImageGenTool({
					backend,
					scratchDir: context.scratchDir,
					conversation: context.conversation,
				}),
			),
		],
	];
	return {
		tools: candidates
			.filter(([name]) => wanted.has(name))
			.map(([name, tool]) =>
				name === "read" || name === "exec_command" ? observeSkillUse(tool, recordSkillUse) : tool,
			),
		background: shell?.background ?? NO_BACKGROUND,
		dispose: async () => await shell?.dispose(),
	};
}

// SKILL.md を読んだ呼び出しを、skill が使われた記録として残す。
function observeSkillUse(
	tool: AnyPiAgentTool,
	recordSkillUse: (names: readonly string[]) => void,
): AnyPiAgentTool {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			recordSkillUse(findSkillNames(params));
			return await tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

// 再生では外へ作用するツールを動かさず、読むだけのツールとWeb検索だけを本物にする。
export function createReplayHarnessTools(
	spec: AgentSessionSpec,
	context: HarnessToolContext,
	backend: ChatGptBackend,
	onCall: (name: HarnessToolName, argumentsValue: unknown) => void,
): HarnessToolSet {
	const read = createReadTool(spec.cwd);
	const live: ReadonlyArray<readonly [HarnessToolName, AnyPiAgentTool]> = [
		["read", read],
		["view_image", createViewImageTool(read)],
		[
			"web_run",
			toPiAgentTool(
				createWebRunTool({
					backend,
					sessionId: context.sessionId,
					model: spec.model.model,
					maxOutputTokens: WEB_RUN_MAX_OUTPUT_TOKENS,
					conversation: context.conversation,
				}),
			),
		],
	];
	const stubbed: readonly HarnessToolName[] = [
		"exec_command",
		"write_stdin",
		"stop_background",
		"edit",
		"write",
		"image_gen",
	];
	const tools = [
		...live.map(([name, tool]) => recordCalls(name, tool, onCall)),
		...stubbed.map((name) =>
			toPiAgentTool({
				name,
				description: `${name} is not executed during a replay. Calls are recorded and treated as successful.`,
				parameters: { type: "object", additionalProperties: true },
				execute: (argumentsValue) => {
					onCall(name, argumentsValue);
					return Promise.resolve({ text: REPLAY_STUB_RESULT, images: [], isError: false });
				},
			}),
		),
	];
	return {
		tools: tools.filter((tool) => spec.harnessTools.some((name) => name === tool.name)),
		background: NO_BACKGROUND,
		dispose: async () => {},
	};
}

const NO_BACKGROUND: HarnessBackground = { count: () => 0, stopAll: async () => {} };

const REPLAY_STUB_RESULT =
	"Replay: this tool was not executed. Treat it as having succeeded and continue.";

function recordCalls(
	name: HarnessToolName,
	tool: AnyPiAgentTool,
	onCall: (name: HarnessToolName, argumentsValue: unknown) => void,
): AnyPiAgentTool {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			onCall(name, params);
			return await tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

// read は画像ファイルを縮小して画像として返す。Codex の view_image と同じ名前で、画像を見る用途を明示する。
function createViewImageTool(read: AnyPiAgentTool): AnyPiAgentTool {
	return {
		name: "view_image",
		label: "view_image",
		description:
			"Look at a local image file (PNG, JPEG, GIF, or WebP). Large images are resized before they are shown to you. path may be absolute or relative to the workspace.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Path to the image file" } },
			required: ["path"],
			additionalProperties: false,
		},
		execute: async (toolCallId, params, signal, onUpdate) =>
			await read.execute(toolCallId, params, signal, onUpdate),
	};
}

// 割り込み判定の鍵は課金を伴うため、エージェントのシェルからは使わせない。
function withoutSecrets(
	environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
	const {
		DISCORD_BOT_TOKEN: _token,
		OPENAI_API_KEY: _openAiKey,
		TYPESAFE_API_KEY: _typesafeKey,
		...rest
	} = environment;
	return rest;
}
