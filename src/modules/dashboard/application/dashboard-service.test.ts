import { describe, expect, it } from "vitest";

import type { DashboardSourcePort } from "../ports/dashboard-source-port";
import { DashboardService } from "./dashboard-service";

describe("DashboardService", () => {
	it("各モジュールの現在の状態を取得時刻と起動時刻付きでまとめる", () => {
		const sources: DashboardSourcePort = {
			activity: () => [],
			agent: () => ({ auth: "ready", lastFailure: null, sessions: [], usage: null }),
			automation: () => ({
				heartbeat: { enabled: true, nextFireAt: null },
				memoryMaintenance: { cron: "0 4 * * *", enabled: true, nextFireAt: null },
				schedule: [],
			}),
			conversations: () => [],
			events: () => [],
			homeAssistant: () => HOME_ASSISTANT_STATUS,
			minecraft: () => MINECRAFT_STATUS,
			tasks: () => ({ maxConcurrent: 2, running: 0, tasks: [] }),
			workspace: () => ({
				disk: { totalBytes: 100, freeBytes: 40 },
				trash: [{ date: "2026-11-14", deleteOn: "2026-11-28", entries: ["old"] }],
			}),
		};
		const service = new DashboardService({
			now: () => new Date("2026-10-20T01:00:00.000Z"),
			sources,
			startedAt: new Date("2026-10-20T00:00:00.000Z"),
		});

		expect(service.snapshot()).toEqual({
			activity: [],
			agent: { auth: "ready", lastFailure: null, sessions: [], usage: null },
			automation: {
				heartbeat: { enabled: true, nextFireAt: null },
				memoryMaintenance: { cron: "0 4 * * *", enabled: true, nextFireAt: null },
				schedule: [],
			},
			conversations: [],
			events: [],
			generatedAt: "2026-10-20T01:00:00.000Z",
			homeAssistant: HOME_ASSISTANT_STATUS,
			minecraft: MINECRAFT_STATUS,
			startedAt: "2026-10-20T00:00:00.000Z",
			tasks: { maxConcurrent: 2, running: 0, tasks: [] },
			workspace: {
				disk: { totalBytes: 100, freeBytes: 40 },
				trash: [{ date: "2026-11-14", deleteOn: "2026-11-28", entries: ["old"] }],
			},
		});
	});
});

const MINECRAFT_STATUS = {
	taskId: "task-1",
	connection: "connected",
	world: "trial-1",
	goal: { objective: "Collect 4 oak logs", targets: { oak_log: 4 }, waypoint: null },
	goalStatus: { status: "in_progress", probability: 0.9 },
	recentActions: [],
	recentEvents: [],
	lastDecisionMs: 120,
} as const;

const HOME_ASSISTANT_STATUS = {
	connection: {
		phase: "connected",
		phaseSince: "2026-10-20T00:00:01.000Z",
		nextRetryAt: null,
		lastError: null,
	},
	watchConfig: { status: "missing" },
	triggered: { count: 0, lastAt: null },
} as const satisfies ReturnType<DashboardSourcePort["homeAssistant"]>;
