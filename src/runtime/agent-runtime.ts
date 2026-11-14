import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import type { Models } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import { ChatGptBackend } from "../modules/agent/adapters/outbound/pi/chatgpt-backend";
import { FileCredentialStore } from "../modules/agent/adapters/outbound/pi/file-credential-store";
import { createImageGenTool } from "../modules/agent/adapters/outbound/pi/image-gen-tool";
import { PiAgentRuntime } from "../modules/agent/adapters/outbound/pi/pi-agent-runtime";
import type { HarnessToolContext } from "../modules/agent/adapters/outbound/pi/pi-agent-runtime";
import type {
	AnyPiAgentTool,
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

export const TURN_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 180_000];
const COMPACTION_RESERVE_TOKENS = 16_384;
const COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const BACKEND_TIMEOUT_MS = 120_000;
const WEB_RUN_MAX_OUTPUT_TOKENS = 10_000;

export function credentialsPath(lunaHomeDir: string): string {
	return resolve(lunaHomeDir, "auth", "credentials.json");
}

export function createAgentModels(lunaHomeDir: string): Models {
	const models = createModels({
		credentials: new FileCredentialStore(credentialsPath(lunaHomeDir)),
	});
	models.setProvider(openaiCodexProvider());
	return models;
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
}): PiAgentRuntime {
	const childEnvironment = withoutSecrets(input.parentEnvironment);
	return new PiAgentRuntime({
		models: input.models,
		transcriptDir: resolve(input.lunaHomeDir, "sessions"),
		retryDelaysMs: TURN_RETRY_DELAYS_MS,
		requestTimeoutMs: input.requestTimeoutMs,
		compaction: {
			model: input.compactionModel,
			reserveTokens: COMPACTION_RESERVE_TOKENS,
			keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
		},
		createHarnessTools: (spec, context) =>
			createHarnessTools(spec, context, input.backend, childEnvironment),
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
): HarnessToolSet {
	const wanted = new Set<HarnessToolName>(spec.harnessTools);
	const shell =
		wanted.has("exec_command") || wanted.has("write_stdin")
			? createShellTools({ cwd: spec.cwd, env: environment })
			: undefined;
	const read = createReadTool(spec.cwd);
	const candidates: ReadonlyArray<readonly [HarnessToolName, AnyPiAgentTool]> = [
		...(shell?.tools ?? []).flatMap((tool): Array<readonly [HarnessToolName, AnyPiAgentTool]> =>
			tool.name === "exec_command" || tool.name === "write_stdin"
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
				createImageGenTool({ backend, cwd: spec.cwd, conversation: context.conversation }),
			),
		],
	];
	return {
		tools: candidates.filter(([name]) => wanted.has(name)).map(([, tool]) => tool),
		dispose: async () => await shell?.dispose(),
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
		dispose: async () => {},
	};
}

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

function withoutSecrets(
	environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
	const { DISCORD_BOT_TOKEN: _token, ...rest } = environment;
	return rest;
}
