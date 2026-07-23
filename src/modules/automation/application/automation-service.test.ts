import { describe, expect, it, vi } from "vitest";

import { AutomationService } from "./automation-service";

describe("AutomationService", () => {
  it("retention清掃、schedule、heartbeatの順で開始する", async () => {
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
    const service = new AutomationService({ heartbeat, retention, schedule });

    await service.startAutomation({ jobs: [] });

    expect(order).toEqual(["retention", "schedule", "heartbeat"]);
  });

  it("起動失敗時は開始済みintakeを停止する", async () => {
    const heartbeat = createHeartbeat();
    const retention = createRetention();
    const schedule = createSchedule({
      start: vi.fn(async () => {
        throw new Error("start failed");
      }),
    });
    const service = new AutomationService({ heartbeat, retention, schedule });

    await expect(service.startAutomation({ jobs: [] })).rejects.toThrow("start failed");

    expect(heartbeat.stopIntake).toHaveBeenCalledTimes(1);
    expect(retention.stopIntake).toHaveBeenCalledTimes(1);
    expect(schedule.stopIntake).toHaveBeenCalledTimes(1);
  });

  it("stopIntakeとdrainを全controllerへ委譲する", async () => {
    const heartbeat = createHeartbeat();
    const retention = createRetention();
    const schedule = createSchedule();
    const service = new AutomationService({ heartbeat, retention, schedule });
    await service.startAutomation({ jobs: [] });

    await service.stopIntake();
    await service.drain();

    expect(heartbeat.stopIntake).toHaveBeenCalledTimes(1);
    expect(retention.stopIntake).toHaveBeenCalledTimes(1);
    expect(schedule.stopIntake).toHaveBeenCalledTimes(1);
    expect(heartbeat.drain).toHaveBeenCalledTimes(1);
    expect(retention.drain).toHaveBeenCalledTimes(1);
    expect(schedule.drain).toHaveBeenCalledTimes(1);
  });
});

function createHeartbeat(overrides: Record<string, unknown> = {}) {
  return {
    drain: vi.fn(async () => undefined),
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
    reloadSchedule: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stopIntake: vi.fn(async () => undefined),
    ...overrides,
  };
}
