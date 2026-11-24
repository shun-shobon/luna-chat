import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import type { ActivityListener } from "../../agent/ports/outbound/agent-session-port";
import { createActivityTable } from "./activity-table";

const message = { kind: "minecraft_event", text: "{}" };

function listener(): {
	notify: Mock<ActivityListener["notify"]>;
	stopped: Mock<ActivityListener["stopped"]>;
} {
	return {
		notify: vi.fn<ActivityListener["notify"]>(),
		stopped: vi.fn<ActivityListener["stopped"]>(),
	};
}

describe("createActivityTable", () => {
	it("つなぐ前の通知を溜め、つないだ時に順に渡す", () => {
		const table = createActivityTable();
		const handle = table.begin(async () => {});
		handle.notify(message, { urgent: false, replaceKey: "a" });
		const connected = listener();

		table.connect(connected);
		handle.notify(message, { urgent: true, replaceKey: null });

		expect(connected.notify.mock.calls).toEqual([
			[{ message, urgent: false, replaceKey: "a" }],
			[{ message, urgent: true, replaceKey: null }],
		]);
	});

	it("二度つなごうとしたら例外にする", () => {
		const table = createActivityTable();
		table.connect(listener());

		expect(() => table.connect(listener())).toThrow("already connected");
	});

	it("stopAll は全作業の後始末を呼び、失敗があっても残りを止めてから例外にする", async () => {
		const table = createActivityTable();
		const connected = listener();
		table.connect(connected);
		const stopped = vi.fn(async () => {});
		const failing = table.begin(async () => {
			throw new Error("切断に失敗");
		});
		table.begin(stopped);

		await expect(table.stopAll()).rejects.toThrow("Failed to stop session activities");

		expect(stopped).toHaveBeenCalledOnce();
		expect(table.count()).toBe(0);
		expect(connected.stopped).toHaveBeenCalledOnce();
		failing.notify(message, { urgent: true, replaceKey: null });
		expect(connected.notify).not.toHaveBeenCalled();
	});

	it("end で作業を外し、セッションに止まったことを伝える", () => {
		const table = createActivityTable();
		const connected = listener();
		table.connect(connected);
		const handle = table.begin(async () => {});

		handle.end();
		handle.end();

		expect(table.count()).toBe(0);
		expect(connected.stopped).toHaveBeenCalledOnce();
	});
});
