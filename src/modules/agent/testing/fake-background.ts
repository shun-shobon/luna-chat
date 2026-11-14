import { vi } from "vitest";
import type { Mock } from "vitest";

import type { AgentSession } from "../ports/outbound/agent-session-port";

export type FakeBackground = {
	hasBackground: Mock<AgentSession["hasBackground"]>;
	waitForBackground: Mock<AgentSession["waitForBackground"]>;
	stopBackground: Mock<AgentSession["stopBackground"]>;
	start(): void;
	// 残りを終わらせ、arrived なら完了通知を次の run まで保留する。
	settle(arrived: boolean): void;
	// run が保留中の完了通知を入力に入れたことにする。
	consume(): void;
};

// AgentSession のバックグラウンド実行の振る舞い（PiAgentSession と同じ規則）を、テストから操作できる形で持つ。
export function createFakeBackground(): FakeBackground {
	const state = { running: false, pending: false };
	const waiters: Array<(arrived: boolean) => void> = [];
	const settle = (arrived: boolean): void => {
		state.running = false;
		if (arrived) state.pending = true;
		for (const resolve of waiters.splice(0)) resolve(arrived);
	};
	return {
		hasBackground: vi.fn<AgentSession["hasBackground"]>(() => state.running || state.pending),
		waitForBackground: vi.fn<AgentSession["waitForBackground"]>(async () => {
			if (state.pending) return true;
			if (!state.running) return false;
			return await new Promise<boolean>((resolve) => {
				waiters.push(resolve);
			});
		}),
		stopBackground: vi.fn<AgentSession["stopBackground"]>(() => {
			settle(false);
			return Promise.resolve();
		}),
		start: () => {
			state.running = true;
		},
		settle,
		consume: () => {
			state.pending = false;
		},
	};
}
