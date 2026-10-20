import { describe, expect, it, vi } from "vitest";

import { AutomationService } from "./automation-service";

describe("AutomationService", () => {
	it("retention清掃、schedule、memory整理、heartbeatの順で開始する", async () => {
		const order: string[] = [];
		const heartbeat = createHeartbeat({
			start: vi.fn(() => {
				order.push("heartbeat");
			}),
		});
		const retention = createRetention({
			start: vi.fn(async () => {
				order.push("retention");
			}),
		});
		const schedule = createSchedule({
			start: vi.fn(async () => {
				order.push("schedule");
			}),
		});
		const memoryMaintenance = createMemoryMaintenance({
			start: vi.fn(() => {
				order.push("memoryMaintenance");
			}),
		});
		const service = new AutomationService({ heartbeat, memoryMaintenance, retention, schedule });

		await service.startAutomation({ jobs: [] });

		expect(order).toEqual(["retention", "schedule", "memoryMaintenance", "heartbeat"]);
	});

	it("stopIntakeとdrainを全controllerへ委譲する", async () => {
		const heartbeat = createHeartbeat();
		const memoryMaintenance = createMemoryMaintenance();
		const retention = createRetention();
		const schedule = createSchedule();
		const service = new AutomationService({ heartbeat, memoryMaintenance, retention, schedule });
		await service.startAutomation({ jobs: [] });

		await service.stopIntake();
		await service.drain();

		expect(heartbeat.stopIntake).toHaveBeenCalledTimes(1);
		expect(memoryMaintenance.stopIntake).toHaveBeenCalledTimes(1);
		expect(retention.stopIntake).toHaveBeenCalledTimes(1);
		expect(schedule.stopIntake).toHaveBeenCalledTimes(1);
		expect(heartbeat.drain).toHaveBeenCalledTimes(1);
		expect(memoryMaintenance.drain).toHaveBeenCalledTimes(1);
		expect(retention.drain).toHaveBeenCalledTimes(1);
		expect(schedule.drain).toHaveBeenCalledTimes(1);
	});

	it("heartbeat、memory整理、scheduleの状態をまとめて返す", () => {
		const service = new AutomationService({
			heartbeat: createHeartbeat({
				snapshot: () => ({ enabled: true, nextFireAt: "2026-01-01T00:10:00.000Z" }),
			}),
			memoryMaintenance: createMemoryMaintenance({
				snapshot: () => ({ cron: "0 4 * * *", enabled: false, nextFireAt: null }),
			}),
			retention: createRetention(),
			schedule: createSchedule({ snapshot: () => [] }),
		});

		expect(service.snapshot()).toEqual({
			heartbeat: { enabled: true, nextFireAt: "2026-01-01T00:10:00.000Z" },
			memoryMaintenance: { cron: "0 4 * * *", enabled: false, nextFireAt: null },
			schedule: [],
		});
	});
});

function createHeartbeat(overrides: Record<string, unknown> = {}) {
	return {
		drain: vi.fn(async () => undefined),
		snapshot: () => ({ enabled: false, nextFireAt: null }),
		start: vi.fn(),
		stopIntake: vi.fn(),
		...overrides,
	};
}

function createMemoryMaintenance(overrides: Record<string, unknown> = {}) {
	return {
		drain: vi.fn(async () => undefined),
		snapshot: () => ({ cron: "", enabled: false, nextFireAt: null }),
		start: vi.fn(),
		stopIntake: vi.fn(),
		...overrides,
	};
}

function createRetention(overrides: Record<string, unknown> = {}) {
	return {
		drain: vi.fn(async () => undefined),
		start: vi.fn(async () => undefined),
		stopIntake: vi.fn(),
		...overrides,
	};
}

function createSchedule(overrides: Record<string, unknown> = {}) {
	return {
		drain: vi.fn(async () => undefined),
		snapshot: () => [],
		start: vi.fn(async () => undefined),
		stopIntake: vi.fn(async () => undefined),
		...overrides,
	};
}
