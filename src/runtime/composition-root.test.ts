import { describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../modules/observability/testing/recording-logger";
import { shutdownApplication } from "./composition-root";

describe("application composition lifecycle", () => {
	it("一つのcleanup失敗後も全resourceを停止して失敗を返す", async () => {
		const calls: string[] = [];
		const failure = new Error("MCP close failed");
		const shutdown = shutdownApplication({
			automation: {
				stopIntake: vi.fn(async () => {
					calls.push("automation.stopIntake");
				}),
				drain: vi.fn(async () => {
					calls.push("automation.drain");
				}),
			},
			clientDestroy: async () => {
				calls.push("client.destroy");
			},
			conversation: {
				stopIntake: vi.fn(() => {
					calls.push("conversation.stopIntake");
				}),
				drain: vi.fn(async () => {
					calls.push("conversation.drain");
				}),
			},
			dashboardClose: async () => {
				calls.push("dashboard.close");
			},
			events: {
				stopBackground: vi.fn(async () => {
					calls.push("events.stopBackground");
				}),
			},
			gateway: {
				stop: vi.fn(() => {
					calls.push("gateway.stop");
				}),
			},
			homeAssistant: {
				stopIntake: () => {
					calls.push("homeAssistant.stopIntake");
				},
				failPending: () => {
					calls.push("homeAssistant.failPending");
				},
				stop: () => {
					calls.push("homeAssistant.stop");
				},
			},
			http: {
				stopIntake: vi.fn(() => calls.push("http.stopIntake")),
				drain: vi.fn(async () => {
					calls.push("http.drain");
				}),
			},
			httpClose: async () => {
				calls.push("http.close");
			},
			httpFailPending: () => {
				calls.push("http.failPending");
			},
			logger: { ...createRecordingLogger(), flush: vi.fn(async () => undefined) },
			tasks: {
				stopIntake: vi.fn(() => {
					calls.push("tasks.stopIntake");
				}),
				drain: vi.fn(async () => {
					calls.push("tasks.drain");
				}),
			},
			typingRelease: () => {
				calls.push("typing.release");
			},
			usageStop: async () => {
				calls.push("usage.stop");
				throw failure;
			},
		});

		await expect(shutdown).rejects.toThrow("Application shutdown failed");
		expect(calls).toEqual(
			expect.arrayContaining([
				"gateway.stop",
				"conversation.stopIntake",
				"automation.stopIntake",
				"http.stopIntake",
				"homeAssistant.stopIntake",
				"tasks.stopIntake",
				"events.stopBackground",
				"conversation.drain",
				"automation.drain",
				"http.drain",
				"tasks.drain",
				"http.failPending",
				"homeAssistant.failPending",
				"homeAssistant.stop",
				"http.close",
				"dashboard.close",
				"typing.release",
				"usage.stop",
				"client.destroy",
			]),
		);
	});
});
