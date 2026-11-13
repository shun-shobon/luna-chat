import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as toolSetModule from "../modules/tool/application/tool-set";
import { startLunaApplication } from "./composition-root";

const fakes = vi.hoisted(() => {
	const client = {
		application: { commands: { create: vi.fn(async () => undefined) } },
		destroy: vi.fn(async () => undefined),
		login: vi.fn(async () => "token"),
		off: vi.fn(),
		on: vi.fn(),
		user: { id: "100" },
	};
	const recurringCrons: string[] = [];
	return { client, recurringCrons };
});

vi.mock("../modules/workspace/adapters/initialize-workspace", () => {
	const model = { provider: "openai-codex", model: "gpt-6.1-sol", thinking: "medium" };
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
					allowedChannelIds: [],
					debounceMs: 100,
					initialHistoryLimit: 20,
					sessionIdleMs: 1_000,
					typingIdleMs: 50,
				},
				heartbeat: { enabled: false, maxIntervalMs: 2_000, minIntervalMs: 1_000 },
				memory: { enabled: true, maintenanceCron: "0 4 * * *" },
				models: { compaction: model, conversation: model, event: model, worker: model },
				tasks: { maxConcurrent: 2 },
			},
			configPath: "/tmp/luna-test/config.toml",
			cronPath: "/tmp/luna-test/workspace/cron.toml",
			lunaHomeDir: "/tmp/luna-test",
			schedule: { jobs: [] },
			tasksDir: "/tmp/luna-test/tasks",
			workspaceDir: "/tmp/luna-test/workspace",
		})),
	};
});

vi.mock("../modules/agent/adapters/outbound/pi/usage-poller", () => ({
	UsagePoller: class {
		start(): void {}
		async stop(): Promise<void> {}
	},
}));

vi.mock("../modules/discord/adapters/discord-gateway-adapter", async (importOriginal) => ({
	...(await importOriginal()),
	createDiscordGatewayClient: vi.fn(() => fakes.client),
}));

vi.mock("../modules/task/adapters/json-file-task-store", () => ({
	JsonFileTaskStore: class {
		async loadAll(): Promise<[]> {
			return [];
		}
		async save(): Promise<void> {}
	},
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
		schedule(cronTime: Date | string): { nextRunAt(): Date | null; stop(): void } {
			if (typeof cronTime !== "string") throw new Error("Unexpected one-shot schedule");
			fakes.recurringCrons.push(cronTime);
			return { nextRunAt: () => null, stop() {} };
		}
	},
}));

const templatesDir = resolve(import.meta.dirname, "../../templates");
const originalEnvironment = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnvironment };
	fakes.recurringCrons.length = 0;
	vi.clearAllMocks();
});

describe("composition root integration", () => {
	it("会話・イベント用と作業エージェント用のツール集合を組み立て、startupからgraceful shutdownまで接続する", async () => {
		process.env = {
			...originalEnvironment,
			DISCORD_BOT_TOKEN: "discord-token",
			LOG_LEVEL: "error",
			LUNA_HOME: "/tmp/luna-test",
		};
		const createToolSet = vi.spyOn(toolSetModule, "createToolSet");
		const application = await startLunaApplication({ templatesDir });

		expect(fakes.client.login).toHaveBeenCalledWith("discord-token");
		expect(fakes.client.on).toHaveBeenCalledTimes(3);
		expect(fakes.client.application.commands.create).toHaveBeenCalledOnce();
		expect(fakes.recurringCrons).toEqual(["0 4 * * *"]);
		const toolNames = createToolSet.mock.results.map((result) =>
			result.type === "return" ? result.value.definitions.map((definition) => definition.name) : [],
		);
		expect(toolNames[0]).toEqual(
			expect.arrayContaining([
				"send_message",
				"open_conversation",
				"http_respond",
				"task_create",
				"task_message",
				"task_cancel",
				"wait",
			]),
		);
		expect(toolNames[1]).toEqual([
			"read_message_history",
			"list_channels",
			"get_user_detail",
			"list_guild_emojis",
			"get_guild_emoji",
			"task_report",
			"wait",
		]);

		await application.shutdown();

		expect(fakes.client.off).toHaveBeenCalledTimes(3);
		expect(fakes.client.destroy).toHaveBeenCalledOnce();
	});

	it("startup中のabortでDiscord接続を閉じる", async () => {
		process.env = {
			...originalEnvironment,
			DISCORD_BOT_TOKEN: "discord-token",
			LOG_LEVEL: "error",
			LUNA_HOME: "/tmp/luna-test",
		};
		const login = deferred<string>();
		fakes.client.login.mockImplementationOnce(async () => await login.promise);
		fakes.client.destroy.mockImplementationOnce(async () => {
			login.reject(new Error("Discord login aborted"));
		});
		const controller = new AbortController();
		const starting = startLunaApplication({ startupSignal: controller.signal, templatesDir });
		await vi.waitFor(() => expect(fakes.client.login).toHaveBeenCalledOnce());

		controller.abort();

		await expect(starting).rejects.toThrow("Discord login aborted");
		expect(fakes.client.destroy).toHaveBeenCalled();
	});

	it("カタログにないモデルが設定されていたら起動しない", async () => {
		process.env = {
			...originalEnvironment,
			DISCORD_BOT_TOKEN: "discord-token",
			LOG_LEVEL: "error",
			LUNA_HOME: "/tmp/luna-test",
		};
		const { initializeWorkspace } =
			await import("../modules/workspace/adapters/initialize-workspace");
		const workspace = await initializeWorkspace({ templatesDir });
		vi.mocked(initializeWorkspace).mockResolvedValueOnce({
			...workspace,
			config: {
				...workspace.config,
				models: {
					...workspace.config.models,
					worker: { provider: "openai-codex", model: "no-such-model", thinking: "medium" },
				},
			},
		});

		await expect(startLunaApplication({ templatesDir })).rejects.toThrow(
			"models.worker: unknown model openai-codex/no-such-model",
		);
		expect(fakes.client.login).not.toHaveBeenCalled();
	});
});

function deferred<T>(): {
	promise: Promise<T>;
	reject(error: Error): void;
} {
	let rejectPromise: ((error: Error) => void) | undefined;
	const promise = new Promise<T>((_resolve, reject) => {
		rejectPromise = reject;
	});
	return {
		promise,
		reject(error) {
			if (rejectPromise === undefined) throw new Error("deferred is not initialized");
			rejectPromise(error);
		},
	};
}
