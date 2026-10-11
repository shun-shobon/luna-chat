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
		const execution = executor.execute(effects, "owner-1");
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
