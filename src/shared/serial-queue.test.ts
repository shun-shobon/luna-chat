import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue";

describe("SerialQueue", () => {
	it("前の処理が終わってから次の処理を始める", async () => {
		const queue = new SerialQueue();
		const events: string[] = [];
		const first = Promise.withResolvers<void>();

		const running = [
			queue.run(async () => {
				events.push("first:start");
				await first.promise;
				events.push("first:end");
			}),
			queue.run(() => {
				events.push("second");
			}),
		];
		await Promise.resolve();
		expect(events).toEqual(["first:start"]);
		first.resolve();
		await Promise.all(running);

		expect(events).toEqual(["first:start", "first:end", "second"]);
	});

	it("失敗は呼び出し元へ返し、後続の処理は続ける", async () => {
		const queue = new SerialQueue();

		const failed = queue.run(() => {
			throw new Error("boom");
		});
		const next = queue.run(() => "ok");

		await expect(failed).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
	});
});
