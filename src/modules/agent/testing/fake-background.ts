import { vi } from "vitest";
import type { Mock } from "vitest";

import type { ActivityWakeup, AgentSession } from "../ports/outbound/agent-session-port";

export type FakeBackground = {
	hasActivity: Mock<AgentSession["hasActivity"]>;
	waitForActivity: Mock<AgentSession["waitForActivity"]>;
	stopActivities: Mock<AgentSession["stopActivities"]>;
	start(): void;
	// 残りを終わらせ、arrived なら通知を次の run まで保留する。
	settle(arrived: boolean): void;
	// 急ぎの通知を保留し、待っているものを起こす（作業は続く）。
	notifyUrgent(): void;
	// run が保留中の通知を入力に入れたことにする。
	consume(): void;
};

// AgentSession の続いている作業の振る舞い（PiAgentSession と同じ規則）を、テストから操作できる形で持つ。
export function createFakeBackground(): FakeBackground {
	const state = { running: false, pending: "none" as ActivityWakeup };
	const waiters: Array<{ urgentOnly: boolean; resolve: (wakeup: ActivityWakeup) => void }> = [];
	const wake = (): void => {
		for (const waiter of waiters.splice(0)) {
			if (waiter.urgentOnly && state.pending !== "urgent" && state.running) {
				waiters.push(waiter);
				continue;
			}
			waiter.resolve(waiter.urgentOnly && state.pending !== "urgent" ? "none" : state.pending);
		}
	};
	const settle = (arrived: boolean): void => {
		state.running = false;
		if (arrived && state.pending === "none") state.pending = "notice";
		wake();
	};
	return {
		hasActivity: vi.fn<AgentSession["hasActivity"]>(
			() => state.running || state.pending !== "none",
		),
		waitForActivity: vi.fn<AgentSession["waitForActivity"]>(async (filter) => {
			const urgentOnly = filter === "urgent";
			if (state.pending === "urgent" || (!urgentOnly && state.pending === "notice")) {
				return state.pending;
			}
			if (!state.running) return "none";
			return await new Promise<ActivityWakeup>((resolve) => {
				waiters.push({ urgentOnly, resolve });
			});
		}),
		stopActivities: vi.fn<AgentSession["stopActivities"]>(() => {
			state.pending = "none";
			settle(false);
			return Promise.resolve();
		}),
		start: () => {
			state.running = true;
		},
		settle,
		notifyUrgent: () => {
			state.pending = "urgent";
			wake();
		},
		consume: () => {
			state.pending = "none";
		},
	};
}
