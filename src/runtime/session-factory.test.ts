import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentRuntimePort,
	AgentSession,
	AgentSessionKind,
	AgentTool,
	ModelSelection,
} from "../modules/agent/ports/outbound/agent-session-port";
import type { ToolSet } from "../modules/tool/application/tool-set";
import type { ToolOrigin } from "../modules/tool/domain/tool";
import { buildSystemPrompt, createSessionFactory } from "./session-factory";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (path) => await rm(path, { force: true, recursive: true })),
	);
});

describe("buildSystemPrompt", () => {
	it("開発者指示、skills、LUNA.md、MEMORY.mdの順に見出し付きで結合する", () => {
		expect(
			buildSystemPrompt({
				developerInstructions: ["PROTOCOL", "DISCORD"],
				skills: "SKILLS",
				luna: "LUNA",
				memory: "MEMORY",
			}),
		).toBe("PROTOCOL\n\nDISCORD\n\nSKILLS\n\n# LUNA.md\n\nLUNA\n\n# MEMORY.md\n\nMEMORY");
	});

	it("読めなかったファイルと空のsectionを省く", () => {
		expect(
			buildSystemPrompt({
				developerInstructions: ["PROTOCOL", " \n"],
				skills: "",
				luna: undefined,
				memory: "MEMORY",
			}),
		).toBe("PROTOCOL\n\n# MEMORY.md\n\nMEMORY");
	});
});

describe("createSessionFactory", () => {
	it.each<[string, ToolOrigin, AgentSessionKind, string, string]>([
		[
			"会話",
			{
				kind: "conversation",
				session: { key: "discord:dm:3:4", source: "discord/main", context: { kind: "dm" } },
			},
			"conversation",
			"discord:dm:3:4",
			"CONVERSATION PROTOCOL\n\nSKILLS\n\n# LUNA.md\n\nI am Luna.\n\n# MEMORY.md\n\nRemember.",
		],
		[
			"イベント",
			{ kind: "event", eventId: "event-1", eventType: "system.heartbeat.fired.v1" },
			"event",
			"system.heartbeat.fired.v1",
			"EVENT PROTOCOL\n\nSKILLS\n\n# LUNA.md\n\nI am Luna.\n\n# MEMORY.md\n\nRemember.",
		],
		[
			"タスク",
			{ kind: "task", taskId: "task-1" },
			"worker",
			"task:task-1",
			"WORKER PROTOCOL\n\nSKILLS",
		],
	])(
		"%sの実行元を種類ごとのプロファイルでセッションにする",
		async (_label, origin, kind, label, systemPrompt) => {
			const workspaceDir = await createWorkspace({
				"LUNA.md": "I am Luna.",
				"MEMORY.md": "Remember.",
			});
			const harness = createHarness(workspaceDir);

			const opened = await harness.open(origin);

			expect(opened).toEqual({ ownerId: "owner-1", session: harness.session });
			expect(harness.agent.open).toHaveBeenCalledWith({
				kind,
				label,
				cwd: workspaceDir,
				systemPrompt,
				model: harness.models[kind],
				tools: [harness.tools[kind]],
				harnessTools: [
					"exec_command",
					"write_stdin",
					"stop_background",
					"read",
					"edit",
					"write",
					"view_image",
					"web_run",
					"image_gen",
				],
			});
			expect(harness.toolSets[kind].bind).toHaveBeenCalledWith({ ownerId: "owner-1", origin });
		},
	);

	it("指定したモデルをプロファイルのモデルより優先する", async () => {
		const harness = createHarness(await createWorkspace({}));
		const model: ModelSelection = { provider: "anthropic", model: "claude", thinking: "high" };

		await harness.open({ kind: "task", taskId: "task-1" }, model);

		expect(harness.agent.open.mock.calls[0]?.[0].model).toEqual(model);
	});

	it("開くたびにownerIdを発行し、LUNA.md・MEMORY.md・skillsを読み直す", async () => {
		const workspaceDir = await createWorkspace({});
		const harness = createHarness(workspaceDir);
		const origin: ToolOrigin = { kind: "event", eventId: "event-1", eventType: "test.v1" };

		const first = await harness.open(origin);
		await writeFile(join(workspaceDir, "MEMORY.md"), "New memory.");
		const second = await harness.open(origin);

		expect([first.ownerId, second.ownerId]).toEqual(["owner-1", "owner-2"]);
		expect(harness.agent.open.mock.calls.map(([spec]) => spec.systemPrompt)).toEqual([
			"EVENT PROTOCOL\n\nSKILLS",
			"EVENT PROTOCOL\n\nSKILLS\n\n# MEMORY.md\n\nNew memory.",
		]);
		expect(harness.readSkillsPrompt).toHaveBeenCalledTimes(2);
	});

	it("ランタイムがセッションを開けなければ失敗を返す", async () => {
		const harness = createHarness(await createWorkspace({}));
		harness.agent.open.mockImplementationOnce(() => {
			throw new Error("model is not available");
		});

		await expect(harness.open({ kind: "task", taskId: "task-1" })).rejects.toThrow(
			"model is not available",
		);
	});
});

function createHarness(workspaceDir: string) {
	const session: AgentSession = {
		id: "session-1",
		run: vi.fn(),
		steer: vi.fn(),
		abort: vi.fn(),
		hasBackground: vi.fn(),
		waitForBackground: vi.fn(),
		stopBackground: vi.fn(),
		setModel: vi.fn(),
		close: vi.fn(),
		status: vi.fn(),
	};
	const agent = {
		open: vi.fn<AgentRuntimePort["open"]>(() => session),
		listModels: vi.fn<AgentRuntimePort["listModels"]>(() => []),
		status: vi.fn<AgentRuntimePort["status"]>(),
	};
	const models: Record<AgentSessionKind, ModelSelection> = {
		conversation: model("conversation"),
		event: model("event"),
		worker: model("worker"),
	};
	const tools: Record<AgentSessionKind, AgentTool> = {
		conversation: tool("conversation"),
		event: tool("event"),
		worker: tool("worker"),
	};
	const toolSets = {
		conversation: toolSet(tools.conversation),
		event: toolSet(tools.event),
		worker: toolSet(tools.worker),
	};
	const readSkillsPrompt = vi.fn(() => "SKILLS");
	let ownerCount = 0;
	const open = createSessionFactory({
		agent,
		createOwnerId: () => `owner-${String(++ownerCount)}`,
		profiles: {
			conversation: profile("conversation"),
			event: profile("event"),
			worker: profile("worker"),
		},
		readSkillsPrompt,
		workspaceDir,
	});
	return { agent, models, open, readSkillsPrompt, session, tools, toolSets };

	function model(kind: AgentSessionKind): ModelSelection {
		return { provider: "openai-codex", model: `${kind}-model`, thinking: "medium" };
	}

	function tool(kind: AgentSessionKind): AgentTool {
		return { name: `${kind}_tool`, description: kind, parameters: {}, execute: vi.fn() };
	}

	function toolSet(bound: AgentTool) {
		return { definitions: [], bind: vi.fn<ToolSet["bind"]>(() => [bound]), release: vi.fn() };
	}

	function profile(kind: AgentSessionKind) {
		return {
			developerInstructions: [`${kind.toUpperCase()} PROTOCOL`],
			includeWorkspaceInstructions: kind !== "worker",
			model: () => models[kind],
			tools: toolSets[kind],
		};
	}
}

async function createWorkspace(files: Readonly<Record<string, string>>): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "luna-session-factory-"));
	temporaryDirectories.push(directory);
	await Promise.all(
		Object.entries(files).map(
			async ([name, content]) => await writeFile(join(directory, name), content),
		),
	);
	return directory;
}
