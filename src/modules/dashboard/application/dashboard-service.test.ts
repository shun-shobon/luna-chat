import { describe, expect, it } from "vitest";

import type { DashboardSourcePort } from "../ports/dashboard-source-port";
import { DashboardService } from "./dashboard-service";

describe("DashboardService", () => {
	it("各モジュールの現在の状態を取得時刻と起動時刻付きでまとめる", () => {
		const sources: DashboardSourcePort = {
			activity: () => [],
			agent: () => ({ lastFailure: null, restartLimit: 5, restartsInWindow: 0, state: "ready" }),
			automation: () => ({
				heartbeat: { enabled: true, nextFireAt: null },
				memoryMaintenance: { cron: "0 4 * * *", enabled: true, nextFireAt: null },
				schedule: [],
			}),
			conversations: () => [],
			events: () => [],
			tasks: () => ({ maxConcurrent: 2, running: 0, tasks: [] }),
		};
		const service = new DashboardService({
			now: () => new Date("2026-10-20T01:00:00.000Z"),
			sources,
			startedAt: new Date("2026-10-20T00:00:00.000Z"),
		});

		expect(service.snapshot()).toEqual({
			activity: [],
			agent: { lastFailure: null, restartLimit: 5, restartsInWindow: 0, state: "ready" },
			automation: {
				heartbeat: { enabled: true, nextFireAt: null },
				memoryMaintenance: { cron: "0 4 * * *", enabled: true, nextFireAt: null },
				schedule: [],
			},
			conversations: [],
			events: [],
			generatedAt: "2026-10-20T01:00:00.000Z",
			startedAt: "2026-10-20T00:00:00.000Z",
			tasks: { maxConcurrent: 2, running: 0, tasks: [] },
		});
	});
});
