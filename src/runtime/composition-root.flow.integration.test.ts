import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DiscordGatewayAdapterModule from "../modules/discord/adapters/discord-gateway-adapter";
import type * as AgentRuntimeModule from "./agent-runtime";
import { startLunaApplication } from "./composition-root";

const fakes = vi.hoisted(() => {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const send = vi.fn(async () => ({ id: "500" }));
	const channel = {
		id: "200",
		isSendable: () => true,
		isTextBased: () => true,
		messages: { fetch: vi.fn(async () => new Map()) },
		send,
		sendTyping: vi.fn(async () => undefined),
	};
	const client = {
		application: { commands: { create: vi.fn(async () => undefined) } },
		channels: { fetch: vi.fn(async () => channel) },
		destroy: vi.fn(async () => undefined),
		login: vi.fn(async () => "token"),
		off: vi.fn((event: string, listener: (payload: unknown) => void) => {
			listeners.get(event)?.delete(listener);
		}),
		on: vi.fn((event: string, listener: (payload: unknown) => void) => {
			const eventListeners = listeners.get(event) ?? new Set();
			eventListeners.add(listener);
			listeners.set(event, eventListeners);
		}),
		user: { id: "999" },
	};
	return {
		client,
		emit(event: string, payload: unknown) {
			for (const listener of listeners.get(event) ?? []) listener(payload);
		},
		lunaHome: "",
		send,
		workspaceDir: "",
	};
});

const faux = vi.hoisted(() => ({
	handle: undefined as ReturnType<typeof fauxProvider> | undefined,
}));

vi.mock("./agent-runtime", async (importOriginal) => {
	const original = await importOriginal<typeof AgentRuntimeModule>();
	return {
		...original,
		createAgentModels: vi.fn(() => {
			const handle = fauxProvider();
			faux.handle = handle;
			const models = createModels();
			models.setProvider(handle.provider);
			return models;
		}),
	};
});

vi.mock("../modules/agent/adapters/outbound/pi/usage", () => ({
	fetchUsage: vi.fn(async () => ({
		fetchedAt: "2026-07-23T00:00:00.000Z",
		limits: [],
		planType: null,
	})),
}));

vi.mock("../modules/workspace/adapters/initialize-workspace", () => {
	const model = { provider: "faux", model: "faux-1", thinking: "off" };
	return {
		initializeWorkspace: vi.fn(async () => ({
			config: {
				agent: {
					requestTimeoutMs: 10_000,
					transcriptCleanupIntervalMs: 86_400_000,
					transcriptRetentionMs: 604_800_000,
				},
				discord: {
					allowDm: true,
					allowedChannelIds: ["200"],
					debounceMs: 1,
					initialHistoryLimit: 20,
					sessionIdleMs: 60_000,
					typingIdleMs: 1,
				},
				heartbeat: { enabled: false, maxIntervalMs: 2_000, minIntervalMs: 1_000 },
				memory: { enabled: true, maintenanceCron: "0 4 * * *" },
				models: { compaction: model, conversation: model, event: model, worker: model },
				tasks: { maxConcurrent: 2 },
			},
			configPath: `${fakes.lunaHome}/config.toml`,
			cronPath: `${fakes.workspaceDir}/cron.toml`,
			lunaHomeDir: fakes.lunaHome,
			schedule: { jobs: [] },
			tasksDir: `${fakes.lunaHome}/tasks`,
			workspaceDir: fakes.workspaceDir,
		})),
	};
});

vi.mock("../modules/discord/adapters/discord-gateway-adapter", async (importOriginal) => ({
	...(await importOriginal<typeof DiscordGatewayAdapterModule>()),
	createDiscordGatewayClient: vi.fn(() => fakes.client),
}));

vi.mock("../modules/http/adapters/http-event-server", () => ({
	startHttpEventServer: vi.fn(async () => ({ close: vi.fn(async () => undefined), port: 3000 })),
}));

vi.mock("../modules/dashboard/adapters/dashboard-server", () => ({
	startDashboardServer: vi.fn(async () => ({ close: vi.fn(async () => undefined), port: 3001 })),
}));

vi.mock("../modules/automation/adapters/chokidar-schedule-watcher", () => ({
	ChokidarScheduleWatcher: class {
		async start(): Promise<void> {}
		async close(): Promise<void> {}
	},
}));

vi.mock("../modules/automation/adapters/cron-schedule-timer", () => ({
	CronScheduleTimer: class {
		schedule(): { nextRunAt(): Date | null; stop(): void } {
			return { nextRunAt: () => null, stop() {} };
		}
	},
}));

const templatesDir = resolve(import.meta.dirname, "../../templates");
const temporaryDirectories: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
	process.env = { ...originalEnvironment };
	await Promise.all(
		temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
	);
	vi.clearAllMocks();
});

describe("composition root flow", () => {
	it("Discordの投稿をpiのセッションへ渡し、送信ツールでDiscordへ返して記憶保存後に閉じる", async () => {
		const root = await mkdtemp(join(tmpdir(), "luna-composition-flow-"));
		temporaryDirectories.push(root);
		fakes.lunaHome = join(root, "home");
		fakes.workspaceDir = join(fakes.lunaHome, "workspace");
		await mkdir(fakes.workspaceDir, { recursive: true });
		await mkdir(join(fakes.lunaHome, "tasks"));
		await Promise.all([
			writeFile(join(fakes.workspaceDir, "LUNA.md"), "Luna persona"),
			writeFile(join(fakes.workspaceDir, "MEMORY.md"), "Memory core"),
		]);
		process.env = {
			...originalEnvironment,
			DISCORD_BOT_TOKEN: "discord-token",
			LOG_LEVEL: "error",
			LUNA_HOME: fakes.lunaHome,
		};

		const application = await startLunaApplication({ templatesDir });
		const handle = faux.handle;
		if (handle === undefined) throw new Error("faux provider was not created");
		handle.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("send_message", {
						target: { kind: "channel", channelId: "200" },
						content: "こんにちは",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("返信しました")]),
			fauxAssistantMessage([fauxText("記憶に残すことはありません")]),
		]);

		fakes.emit("messageCreate", discordMessage());
		await vi.waitFor(() => expect(fakes.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
		await application.shutdown();

		expect(fakes.send).toHaveBeenCalledWith({ content: "こんにちは" });
		expect(handle.state.callCount).toBe(3);
		const transcripts = await readTranscripts(join(fakes.lunaHome, "sessions"));
		expect(transcripts).toHaveLength(1);
		expect(transcripts[0]).toContain("Luna persona");
		expect(transcripts[0]).toContain('"kind":"discord_message"');
		expect(transcripts[0]).toContain('"kind":"session_end"');
		expect(fakes.client.destroy).toHaveBeenCalledOnce();
	});
});

async function readTranscripts(directory: string): Promise<string[]> {
	const days = await readdir(directory);
	const files = (
		await Promise.all(
			days.map(async (day) =>
				(await readdir(join(directory, day))).map((file) => join(directory, day, file)),
			),
		)
	).flat();
	return await Promise.all(files.map(async (file) => await readFile(file, "utf8")));
}

function discordMessage() {
	return {
		id: "400",
		createdAt: new Date("2026-07-23T00:00:00.000Z"),
		system: false,
		guild: { id: "300", name: "Luna Lab" },
		channel: {
			id: "200",
			type: ChannelType.GuildText,
			name: "general",
			parentId: null,
			recipient: null,
		},
		author: { id: "100", username: "shun", globalName: "Shun", bot: false, system: false },
		member: { displayName: "Shun" },
		webhookId: null,
		content: "hello",
		attachments: new Map(),
		stickers: new Map(),
		reactions: { cache: new Map() },
		mentions: { users: new Map(), roles: new Map(), channels: new Map(), everyone: false },
		reference: null,
	};
}
