import { z } from "zod";

import { jsonValueSchema } from "../../../shared/json";
import { minecraftActionSchema } from "../domain/action";
import { reflexTriggerSchema } from "../domain/reflex";
import { vec3Schema, worldSnapshotSchema } from "../domain/world";

// メインスレッドとMineflayerのワーカースレッドの間のメッセージ。受け取った側でこのスキーマで検証する。

const itemCountsSchema = z.record(z.string(), z.number().int().min(1));

export const workerRequestSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("connect"),
		id: z.number().int(),
		host: z.string(),
		port: z.number().int(),
		username: z.string(),
		actionsDir: z.string(),
	}),
	z.strictObject({
		type: z.literal("observe"),
		id: z.number().int(),
		targetItems: z.array(z.string()),
		verify: z.array(vec3Schema),
	}),
	z.strictObject({
		type: z.literal("execute"),
		id: z.number().int(),
		action: minecraftActionSchema,
	}),
	// 実行中の execute（id が同じもの）を中断する。返事はしない。
	z.strictObject({ type: z.literal("abort"), id: z.number().int() }),
	z.strictObject({
		type: z.literal("unknownItems"),
		id: z.number().int(),
		names: z.array(z.string()),
	}),
	z.strictObject({ type: z.literal("customActions"), id: z.number().int() }),
	z.strictObject({ type: z.literal("close"), id: z.number().int() }),
]);
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

const actionOutcomeSchema = z.strictObject({
	result: z.enum(["succeeded", "failed", "interrupted"]),
	detail: z.string(),
	chest: z.strictObject({ position: vec3Schema, items: itemCountsSchema }).nullable(),
});

// 返事は ok で成否が分かれ type が重なるため、判別ではなく順に試す union にする。
export const workerMessageSchema = z.union([
	z.strictObject({
		type: z.literal("response"),
		id: z.number().int(),
		ok: z.literal(true),
		value: z.unknown(),
	}),
	z.strictObject({
		type: z.literal("response"),
		id: z.number().int(),
		ok: z.literal(false),
		error: z.string(),
	}),
	z.strictObject({ type: z.literal("reflexed"), trigger: reflexTriggerSchema, detail: z.string() }),
	z.strictObject({
		type: z.literal("died"),
		message: z.string(),
		position: vec3Schema,
		dimension: z.string(),
		lostItems: itemCountsSchema,
	}),
	z.strictObject({ type: z.literal("disconnected"), reason: z.string() }),
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;

// 要求の種類ごとの返事の値。
export const responseValueSchemas = {
	connect: z.null(),
	observe: worldSnapshotSchema,
	execute: actionOutcomeSchema,
	unknownItems: z.array(z.string()),
	customActions: z.strictObject({
		loaded: z.array(z.string()),
		candidates: z.array(
			z.strictObject({
				name: z.string(),
				description: z.string(),
				args: jsonValueSchema.nullable(),
				timeoutMs: z.number().int(),
			}),
		),
		errors: z.array(z.strictObject({ name: z.string(), error: z.string() })),
	}),
	close: z.null(),
} as const;
