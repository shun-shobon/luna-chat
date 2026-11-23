import { z } from "zod";

import { defineTool } from "../../tool/ports/tool-provider";
import type { ToolProvider } from "../../tool/ports/tool-provider";
import type { MinecraftPlayService } from "../application/minecraft-play-service";

type MinecraftPlay = Pick<MinecraftPlayService, "namePlace" | "observe" | "setGoal">;

const itemNameSchema = z
	.string()
	.regex(/^[a-z0-9_]+$/u, "Use Minecraft item ids such as iron_ingot");
const integerVec3Schema = z.strictObject({
	x: z.number().int(),
	y: z.number().int(),
	z: z.number().int(),
});

const goalInputSchema = z.strictObject({
	objective: z.string().trim().min(1).max(500),
	targets: z.record(itemNameSchema, z.number().int().min(1)).optional(),
	waypoint: z.union([integerVec3Schema, z.string().trim().min(1).max(64)]).optional(),
});
const observeInputSchema = z.strictObject({});
const namePlaceInputSchema = z.strictObject({
	name: z.string().trim().min(1).max(64),
	position: integerVec3Schema.optional(),
});

// minecraft の作業エージェントだけに渡す計画役のツール（SPEC §25.6）。
export function createMinecraftToolProvider(play: MinecraftPlay): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "minecraft_goal",
				description:
					'Set the goal that Luna\'s in-game controller pursues one action at a time, replacing the current one. Returns at once; the controller keeps playing while you think. objective is a short instruction in English, such as "Collect 3 oak logs". targets optionally lists item ids and counts; once the inventory holds all of them, the goal counts as done. waypoint optionally gives a block position or a place name you set with minecraft_name_place. The first Minecraft tool call of your task connects to the server.',
				inputSchema: goalInputSchema,
				parseInput: (input) => ({
					objective: input.objective,
					targets: input.targets ?? {},
					waypoint: input.waypoint ?? null,
				}),
				execute: async (input, execution) => await play.setGoal(execution, input),
				describeTarget: (input) => ({ objective: input.objective }),
			}),
			defineTool({
				name: "minecraft_observe",
				description:
					"Look at the game now: what Luna sees and remembers, her inventory and health, the goal and how the controller judges it, and recent events.",
				inputSchema: observeInputSchema,
				parseInput: (input) => input,
				execute: async (_input, execution) => await play.observe(execution),
				describeTarget: () => null,
			}),
			defineTool({
				name: "minecraft_name_place",
				description:
					"Remember a place by name, such as base or mine entrance, so you can use the name as a waypoint later. position defaults to where Luna stands. A name you reuse is moved.",
				inputSchema: namePlaceInputSchema,
				parseInput: (input) => ({ name: input.name, position: input.position ?? null }),
				execute: async (input, execution) => await play.namePlace(execution, input),
				describeTarget: (input) => ({ name: input.name }),
			}),
		]),
		release: async () => {},
	});
}
