import { afterEach, describe, expect, it, vi } from "vitest";

import { createEffectOutputContract } from "../application/effect-output-contract";
import { createEffectRegistry } from "../application/effect-registry";
import { createEffectBatchExecutor } from "../application/execute-effect-batch";
import { createWaitEffectProvider } from "./wait-effect-provider";

afterEach(() => vi.useRealTimers());

describe("system.wait", () => {
	it("正の整数秒だけ待って完了結果を返す", async () => {
		vi.useFakeTimers();
		const registry = createEffectRegistry([createWaitEffectProvider()]);
		const contract = createEffectOutputContract(registry);
		const effects = contract.parse(
			JSON.stringify({ effects: [{ type: "system.wait", input: { duration_seconds: 60 } }] }),
		).effects;
		const executor = createEffectBatchExecutor(registry, { log: vi.fn() });
		const execution = executor.execute(effects, {
			ownerId: "owner-1",
			origin: { kind: "event", eventId: "event-1", eventType: "test.v1" },
		});
		let settled = false;
		void execution.then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(59_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(execution).resolves.toEqual([
			{
				index: 0,
				type: "system.wait",
				target: null,
				success: true,
				value: { duration_seconds: 60 },
			},
		]);
	});

	it("同じ実行元のreleaseで待機を打ち切り、他の実行元の待機は続ける", async () => {
		vi.useFakeTimers();
		const registry = createEffectRegistry([createWaitEffectProvider()]);
		const contract = createEffectOutputContract(registry);
		const parse = () =>
			contract.parse(
				JSON.stringify({ effects: [{ type: "system.wait", input: { duration_seconds: 60 } }] }),
			).effects;
		const executor = createEffectBatchExecutor(registry, { log: vi.fn() });
		const origin = { kind: "event", eventId: "event-1", eventType: "test.v1" } as const;
		const cancelled = executor.execute(parse(), { ownerId: "owner-1", origin });
		const continuing = executor.execute(parse(), { ownerId: "owner-2", origin });

		await executor.release("owner-1");

		await expect(cancelled).resolves.toEqual([
			{ index: 0, type: "system.wait", target: null, success: false, error: "Wait was cancelled" },
		]);
		let settled = false;
		void continuing.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(59_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(continuing).resolves.toMatchObject([{ success: true }]);
	});

	it("不正な秒数を実行前に拒否する", () => {
		const contract = createEffectOutputContract(createEffectRegistry([createWaitEffectProvider()]));
		for (const duration_seconds of [0, -1, 1.5, "60", 2_147_484]) {
			expect(() =>
				contract.parse(
					JSON.stringify({ effects: [{ type: "system.wait", input: { duration_seconds } }] }),
				),
			).toThrow("Invalid effect system.wait:");
		}
	});
});
