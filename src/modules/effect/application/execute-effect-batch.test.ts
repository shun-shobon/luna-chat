import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { LoggerPort } from "../../observability/ports/logger-port";
import type { EffectRequest } from "../domain/effect";
import type { EffectProvider } from "../ports/effect-provider";
import { defineEffect } from "../ports/effect-provider";
import { createEffectRegistry } from "./effect-registry";
import type { EffectRegistry } from "./effect-registry";
import { createEffectBatchExecutor } from "./execute-effect-batch";

const inputSchema = z.strictObject({ target: z.string(), value: z.string() });

function createLogger(): LoggerPort {
	return { log: vi.fn() };
}

describe("createEffectBatchExecutor", () => {
	it("全Effectを並行開始し、入力順でresultを返す", async () => {
		const started: string[] = [];
		const resolvers = new Map<string, () => void>();
		const provider: EffectProvider = {
			definitions: [
				defineEffect({
					type: "fake.record",
					agentInputSchema: inputSchema,
					parseInput: (input) => input,
					execute: async (input) => {
						started.push(input.value);
						await new Promise<void>((resolve) => {
							resolvers.set(input.value, resolve);
						});
						return { recorded: input.value };
					},
					describeTarget: (input) => input.target,
				}),
			],
			release: async () => {},
		};
		const registry = createEffectRegistry([provider]);
		const executor = createEffectBatchExecutor(registry, createLogger());

		const execution = executor.execute(
			[
				parseRecord(registry, { target: "first-target", value: "first" }),
				parseRecord(registry, { target: "second-target", value: "second" }),
			],
			"owner-1",
		);
		await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
		resolvers.get("second")?.();
		resolvers.get("first")?.();

		await expect(execution).resolves.toEqual([
			{
				index: 0,
				type: "fake.record",
				target: "first-target",
				success: true,
				value: { recorded: "first" },
			},
			{
				index: 1,
				type: "fake.record",
				target: "second-target",
				success: true,
				value: { recorded: "second" },
			},
		]);
	});

	it("一件が失敗しても他のresultを保持し、errorを文字列化する", async () => {
		const provider: EffectProvider = {
			definitions: [
				defineEffect({
					type: "fake.record",
					agentInputSchema: inputSchema,
					parseInput: (input) => input,
					execute: async (input) => {
						if (input.value === "failure") throw new Error("record failed");
						return { recorded: input.value };
					},
					describeTarget: (input) => input.target,
				}),
			],
			release: async () => {},
		};
		const registry = createEffectRegistry([provider]);
		const executor = createEffectBatchExecutor(registry, createLogger());

		await expect(
			executor.execute(
				[
					parseRecord(registry, { target: "bad", value: "failure" }),
					parseRecord(registry, { target: "good", value: "success" }),
				],
				"owner-1",
			),
		).resolves.toEqual([
			{
				index: 0,
				type: "fake.record",
				target: "bad",
				success: false,
				error: "record failed",
			},
			{
				index: 1,
				type: "fake.record",
				target: "good",
				success: true,
				value: { recorded: "success" },
			},
		]);
	});

	it("releaseを全Providerへ渡し、失敗をlogする", async () => {
		const firstRelease = vi.fn(async () => {});
		const secondRelease = vi.fn(async () => {
			throw new Error("cleanup failed");
		});
		const first = createProvider("fake.first", firstRelease);
		const second = createProvider("fake.second", secondRelease);
		const log = vi.fn();
		const logger: LoggerPort = { log };
		const executor = createEffectBatchExecutor(createEffectRegistry([first, second]), logger);

		await expect(executor.release("owner-1")).resolves.toBeUndefined();

		expect(firstRelease).toHaveBeenCalledWith("owner-1");
		expect(secondRelease).toHaveBeenCalledWith("owner-1");
		expect(log).toHaveBeenCalledWith(
			"warn",
			"effect.provider_release_failed",
			{},
			{
				error: expect.objectContaining({ message: "cleanup failed" }),
				ownerId: "owner-1",
				providerIndex: 1,
			},
		);
	});
});

function createProvider(type: string, release: (ownerId: string) => Promise<void>): EffectProvider {
	return {
		definitions: [
			defineEffect({
				type,
				agentInputSchema: inputSchema,
				parseInput: (input) => input,
				execute: async (input) => input,
				describeTarget: (input) => input.target,
			}),
		],
		release,
	};
}

function parseRecord(registry: EffectRegistry, input: z.infer<typeof inputSchema>): EffectRequest {
	return registry.getDefinition("fake.record").parse(input);
}
