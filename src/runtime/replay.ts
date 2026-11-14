import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Models } from "@earendil-works/pi-ai/models";
import { z } from "zod";

import type { ChatGptBackend } from "../modules/agent/adapters/outbound/pi/chatgpt-backend";
import { PiAgentRuntime } from "../modules/agent/adapters/outbound/pi/pi-agent-runtime";
import type {
	AgentSession,
	HarnessToolName,
	ModelSelection,
} from "../modules/agent/ports/outbound/agent-session-port";
import { createDiscordToolProvider } from "../modules/discord/adapters/discord-tool-provider";
import { createHttpResponseToolProvider } from "../modules/http/adapters/http-response-tool-provider";
import { HttpResponseRegistry } from "../modules/http/application/http-response-registry";
import type { LoggerPort } from "../modules/observability/ports/logger-port";
import { createTaskBoardToolProvider } from "../modules/task/adapters/task-tool-provider";
import { createToolSet } from "../modules/tool/application/tool-set";
import { readWorkspaceConfig } from "../modules/workspace/adapters/config-toml";
import { resolveLunaHome } from "../modules/workspace/adapters/initialize-workspace";
import { readWorkspaceSkillsPrompt } from "../modules/workspace/adapters/workspace-skills";
import { readWorkspaceBaseInstructions } from "../modules/workspace/application/workspace-instructions";
import { createAgentModels, createChatGptBackend, createReplayHarnessTools } from "./agent-runtime";
import { buildSystemPrompt } from "./session-factory";
import { SESSION_DEVELOPER_INSTRUCTIONS } from "./session-instructions";

// 1場面で記録するツール呼び出しの上限。止まらない探索で使用枠を使い切らないよう、超えたら打ち切る。
const MAX_CALLS_PER_SCENE = 12;
const REPLAY_HARNESS_TOOLS: readonly HarnessToolName[] = [
	"exec_command",
	"write_stdin",
	"read",
	"edit",
	"write",
	"view_image",
	"web_run",
	"image_gen",
];

const replaySceneSchema = z.strictObject({
	id: z.string().trim().min(1),
	note: z.string().optional(),
	inputs: z.array(z.strictObject({ kind: z.string().trim().min(1), text: z.string() })).min(1),
});
const replayScenesSchema = z.array(replaySceneSchema).min(1);

export type ReplayScene = z.infer<typeof replaySceneSchema>;
export type ReplayVariant = Readonly<{ name: string; systemPrompt: string }>;
export type ReplayCall = Readonly<{ tool: string; arguments: unknown }>;
export type ReplayResult = Readonly<{
	scene: string;
	variant: string;
	status: string;
	calls: readonly ReplayCall[];
}>;

const silentLogger: LoggerPort = { child: () => silentLogger, info() {}, warn() {}, error() {} };
const REPLAY_ORIGIN = { kind: "event", eventId: "replay", eventType: "replay" } as const;
const REPLAY_SCOPE = { kind: "guild_channel", guildId: "0", channelId: "0" } as const;

export async function runReplay(input: {
	backend: ChatGptBackend;
	cwd: string;
	model: ModelSelection;
	models: Models;
	requestTimeoutMs: number;
	scenes: readonly ReplayScene[];
	transcriptDir: string;
	variants: readonly ReplayVariant[];
	onResult?: (result: ReplayResult) => void;
}): Promise<ReplayResult[]> {
	let calls: ReplayCall[] = [];
	let session: AgentSession | undefined;
	const record = (tool: string, argumentsValue: unknown): void => {
		calls.push({ tool, arguments: argumentsValue });
		if (calls.length >= MAX_CALLS_PER_SCENE) void session?.abort();
	};
	const runtime = new PiAgentRuntime({
		models: input.models,
		transcriptDir: input.transcriptDir,
		retryDelaysMs: [15_000],
		requestTimeoutMs: input.requestTimeoutMs,
		compaction: { model: input.model, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		createHarnessTools: (spec, context) =>
			createReplayHarnessTools(spec, context, input.backend, record),
		hasCredentials: () => true,
		logger: silentLogger,
		now: () => new Date(),
	});
	const tools = createRecordingToolSet(record).bind({
		ownerId: "replay",
		origin: REPLAY_ORIGIN,
	});

	const results: ReplayResult[] = [];
	for (const scene of input.scenes) {
		for (const variant of input.variants) {
			calls = [];
			session = runtime.open({
				kind: "conversation",
				label: `replay:${scene.id}:${variant.name}`,
				cwd: input.cwd,
				systemPrompt: variant.systemPrompt,
				model: input.model,
				tools,
				harnessTools: REPLAY_HARNESS_TOOLS,
			});
			let status: string;
			try {
				const run = await session.run(scene.inputs);
				status = run.status === "failed" ? `failed: ${run.reason}: ${run.message}` : run.status;
			} finally {
				await session.close();
			}
			const result = { scene: scene.id, variant: variant.name, status, calls };
			results.push(result);
			input.onResult?.(result);
		}
	}
	return results;
}

// どの指示で出た結果かを伏せて採点できるよう、場面ごとに候補の並びを入れ替えて A, B… と名付ける。
export function blindResults(
	results: readonly ReplayResult[],
	random: () => number,
): Readonly<{
	candidates: Array<{ scene: string; candidates: Record<string, readonly ReplayCall[]> }>;
	key: Record<string, Record<string, string>>;
}> {
	const scenes = [...new Set(results.map((result) => result.scene))];
	const candidates: Array<{ scene: string; candidates: Record<string, readonly ReplayCall[]> }> =
		[];
	const key: Record<string, Record<string, string>> = {};
	for (const scene of scenes) {
		const shuffled = shuffle(
			results.filter((result) => result.scene === scene),
			random,
		);
		const labeled: Record<string, readonly ReplayCall[]> = {};
		const sceneKey: Record<string, string> = {};
		shuffled.forEach((result, index) => {
			const label = String.fromCodePoint(65 + index);
			labeled[label] = result.calls;
			sceneKey[label] = result.variant;
		});
		candidates.push({ scene, candidates: labeled });
		key[scene] = sceneKey;
	}
	return { candidates, key };
}

export function parseReplayVariants(
	values: readonly string[],
): ReadonlyArray<Readonly<{ name: string; dir: string }>> {
	const variants = values.map((raw) => {
		const separator = raw.indexOf("=");
		if (separator <= 0 || separator === raw.length - 1) {
			throw new Error(`variant must be <name>=<dir>: ${raw}`);
		}
		return { name: raw.slice(0, separator), dir: raw.slice(separator + 1) };
	});
	if (variants.length === 0) {
		throw new Error("At least one variant is required");
	}
	if (new Set(variants.map((variant) => variant.name)).size !== variants.length) {
		throw new Error("variant names must be unique");
	}
	return variants;
}

export async function runReplayCommand(
	options: Readonly<{
		scenesPath: string;
		outDir: string;
		variants: ReadonlyArray<Readonly<{ name: string; dir: string }>>;
	}>,
): Promise<void> {
	const lunaHomeDir = resolveLunaHome(process.env["LUNA_HOME"]);
	const workspaceDir = resolve(lunaHomeDir, "workspace");
	const config = await readWorkspaceConfig(resolve(lunaHomeDir, "config.toml"));
	const scenes = replayScenesSchema.parse(JSON.parse(await readFile(options.scenesPath, "utf8")));
	const skills = readWorkspaceSkillsPrompt(workspaceDir);
	const variants = await Promise.all(
		options.variants.map(async (variant) => {
			const instructions = await readWorkspaceBaseInstructions(resolve(variant.dir));
			return {
				name: variant.name,
				systemPrompt: buildSystemPrompt({
					developerInstructions: SESSION_DEVELOPER_INSTRUCTIONS.conversation,
					skills,
					luna: instructions.luna,
					memory: instructions.memory,
				}),
			};
		}),
	);

	const models = createAgentModels(lunaHomeDir);
	// 再生の記録を本物の会話記録に混ぜないよう、一時ディレクトリへ書いて最後に消す。
	const transcriptDir = await mkdtemp(join(tmpdir(), "luna-replay-"));
	try {
		const results = await runReplay({
			backend: createChatGptBackend(models),
			cwd: workspaceDir,
			model: config.models.conversation,
			models,
			requestTimeoutMs: config.agent.requestTimeoutMs,
			scenes,
			transcriptDir,
			variants,
			onResult: (result) => {
				process.stdout.write(
					`${result.scene} ${result.variant} ${result.status} calls=${String(result.calls.length)}\n`,
				);
			},
		});
		const blind = blindResults(results, Math.random);
		await mkdir(options.outDir, { recursive: true });
		await Promise.all([
			writeJson(join(options.outDir, "results.json"), results),
			writeJson(join(options.outDir, "blind.json"), blind.candidates),
			writeJson(join(options.outDir, "blind-key.json"), blind.key),
		]);
	} finally {
		await rm(transcriptDir, { recursive: true, force: true });
	}
}

function createRecordingToolSet(record: (tool: string, argumentsValue: unknown) => void) {
	const recorded = <T>(tool: string, argumentsValue: unknown, value: T): Promise<T> => {
		record(tool, argumentsValue);
		return Promise.resolve(value);
	};
	const unavailable = (tool: string, argumentsValue: unknown): Promise<never> => {
		record(tool, argumentsValue);
		return Promise.reject(new Error(`${tool} is unavailable during a replay`));
	};
	return createToolSet(
		[
			createDiscordToolProvider({
				actions: {
					execute: async (action) =>
						await recorded(action.kind, action, {
							actionKind: action.kind,
							detail: { messageId: "0" },
						}),
					releaseTyping: async () => {},
				},
				delegation: {
					delegate: async (target, brief) =>
						await recorded("open_conversation", { target, brief }, REPLAY_SCOPE),
				},
				read: {
					readMessageHistory: async (historyInput) =>
						await recorded("read_message_history", historyInput, []),
					listChannels: async () => await recorded("list_channels", {}, []),
					getUserDetail: async (userInput) => await unavailable("get_user_detail", userInput),
					listGuildEmojis: async (guildId) => await recorded("list_guild_emojis", { guildId }, []),
					getGuildEmoji: async (emojiInput) => await unavailable("get_guild_emoji", emojiInput),
				},
			}),
			createHttpResponseToolProvider(new HttpResponseRegistry()),
			createTaskBoardToolProvider({
				create: async (_origin, taskInput) =>
					await recorded("task_create", taskInput, {
						version: 1,
						id: "replay",
						title: taskInput.title,
						instructions: taskInput.instructions,
						origin: REPLAY_ORIGIN,
						private: false,
						status: "queued",
						attempts: 0,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						reports: [],
						messages: [],
						outcome: null,
					}),
				message: async (_origin, taskId, text) =>
					await recorded("task_message", { taskId, text }, "running"),
				cancel: async (_origin, taskId, reason) =>
					await recorded("task_cancel", { taskId, reason }, "cancelled"),
				report: async (_origin, reportInput) => await unavailable("task_report", reportInput),
			}),
		],
		silentLogger,
	);
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
	return items
		.map((item) => ({ item, order: random() }))
		.toSorted((left, right) => left.order - right.order)
		.map(({ item }) => item);
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}
