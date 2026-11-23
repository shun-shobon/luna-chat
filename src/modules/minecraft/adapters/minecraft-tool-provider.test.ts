import { describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import { createActivityTable } from "../../tool/application/activity-table";
import { createToolSet } from "../../tool/application/tool-set";
import type { MinecraftPlayService } from "../application/minecraft-play-service";
import { createMinecraftToolProvider } from "./minecraft-tool-provider";

function bind() {
	const play = {
		setGoal: vi.fn<MinecraftPlayService["setGoal"]>(async () => ({
			accepted_at: "2026-11-23T10:00:00.000Z",
		})),
		observe: vi.fn<MinecraftPlayService["observe"]>(async () => ({ self: {} })),
		namePlace: vi.fn<MinecraftPlayService["namePlace"]>(async (_execution, input) => ({
			name: input.name,
			position: input.position ?? { x: 0, y: 64, z: 0 },
		})),
	};
	const tools = createToolSet([createMinecraftToolProvider(play)], createRecordingLogger()).bind({
		ownerId: "owner-1",
		origin: { kind: "task", taskId: "task-1", worker: "minecraft" },
		activities: createActivityTable(),
	});
	const run = async (name: string, input: unknown) => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`missing ${name}`);
		return await tool.execute(input, new AbortController().signal);
	};
	return { play, run, tools };
}

describe("createMinecraftToolProvider", () => {
	it("3つの計画役のツールを出す", () => {
		expect(bind().tools.map((tool) => tool.name)).toEqual([
			"minecraft_goal",
			"minecraft_observe",
			"minecraft_name_place",
		]);
	});

	it("目標の targets と waypoint は省略を空にして渡し、場所の名前も位置も受ける", async () => {
		const { play, run } = bind();

		await run("minecraft_goal", { objective: "Collect 4 oak logs" });
		await run("minecraft_goal", { objective: "Go home", waypoint: "base" });
		await run("minecraft_goal", {
			objective: "Go",
			targets: { iron_ingot: 3 },
			waypoint: { x: 1, y: 2, z: 3 },
		});

		expect(play.setGoal.mock.calls.map(([, input]) => input)).toEqual([
			{ objective: "Collect 4 oak logs", targets: {}, waypoint: null },
			{ objective: "Go home", targets: {}, waypoint: "base" },
			{ objective: "Go", targets: { iron_ingot: 3 }, waypoint: { x: 1, y: 2, z: 3 } },
		]);
	});

	it.each([
		["空の目標", { objective: " " }],
		["アイテム名でない targets", { objective: "x", targets: { "Iron Ingot": 1 } }],
		["0個の targets", { objective: "x", targets: { iron_ingot: 0 } }],
		["整数でない waypoint", { objective: "x", waypoint: { x: 1.5, y: 2, z: 3 } }],
	])("%s は実行せずにツールの失敗にする", async (_label, input) => {
		const { play, run } = bind();

		await expect(run("minecraft_goal", input)).resolves.toMatchObject({ isError: true });
		expect(play.setGoal).not.toHaveBeenCalled();
	});

	it("場所の命名で position を省略すると null を渡す", async () => {
		const { play, run } = bind();

		await run("minecraft_name_place", { name: "base" });

		expect(play.namePlace.mock.calls[0]?.[1]).toEqual({ name: "base", position: null });
	});
});
