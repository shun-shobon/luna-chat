import { describe, expect, it, vi } from "vitest";

import type { AcceptedConversationEvent } from "../../conversation/domain/conversation-session";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import { STATE_CHANGES_SESSION } from "../domain/home-assistant-event";
import type { WatchConfigState } from "../domain/home-assistant-status";
import type { StateChange } from "../domain/state-change";
import { StateChangeWatcher } from "./state-change-watcher";

const VALID: WatchConfigState = {
	status: "valid",
	config: { watch: ["binary_sensor.*"], ignore: [], cooldownSeconds: 30 },
};
const CONNECTION = {
	phase: "connected",
	phaseSince: "2026-11-14T00:00:00.000Z",
	nextRetryAt: null,
	lastError: null,
} as const;

describe("StateChangeWatcher", () => {
	it("起動の対象になった変化をstate_changesの会話へイベントとして渡し、ログに残す", () => {
		const harness = createHarness();

		harness.watcher.handle(change("binary_sensor.front_door", "off", "on"));

		expect(harness.accepted).toEqual([
			{
				session: STATE_CHANGES_SESSION,
				event: expect.objectContaining({
					id: "id-1",
					type: "home_assistant.state_changed.v1",
					subject: "binary_sensor.front_door",
				}),
			},
		]);
		expect(harness.logger.entries).toContainEqual(
			expect.objectContaining({
				level: "info",
				event: "home_assistant.state_change_triggered",
				details: { entityId: "binary_sensor.front_door", eventId: "id-1" },
			}),
		);
	});

	it("cooldownはエンティティごとに数える", () => {
		const harness = createHarness();

		harness.watcher.handle(change("binary_sensor.front_door", "off", "on"));
		harness.watcher.handle(change("binary_sensor.back_door", "off", "on"));
		harness.advance(29_000);
		harness.watcher.handle(change("binary_sensor.front_door", "on", "off"));
		harness.advance(1_000);
		harness.watcher.handle(change("binary_sensor.front_door", "on", "off"));

		expect(harness.accepted.map((input) => input.event.subject)).toEqual([
			"binary_sensor.front_door",
			"binary_sensor.back_door",
			"binary_sensor.front_door",
		]);
	});

	it.each([
		["missing", { status: "missing" }],
		["invalid", { status: "invalid", error: "bad" }],
	] satisfies Array<[string, WatchConfigState]>)(
		"監視ファイルが%sなら何も渡さない",
		(_label, config) => {
			const harness = createHarness({ config });

			harness.watcher.handle(change("binary_sensor.front_door", "off", "on"));

			expect(harness.accepted).toEqual([]);
		},
	);

	it("会話が受け付けなかった変化はcooldownも回数も記録しない", () => {
		const harness = createHarness({ accept: false });

		harness.watcher.handle(change("binary_sensor.front_door", "off", "on"));
		harness.acceptNext(true);
		harness.watcher.handle(change("binary_sensor.front_door", "on", "off"));

		expect(harness.accepted).toHaveLength(1);
		expect(harness.watcher.status().triggered.count).toBe(1);
	});

	it("stopIntakeの後は変化を無視する", () => {
		const harness = createHarness();

		harness.watcher.stopIntake();
		harness.watcher.handle(change("binary_sensor.front_door", "off", "on"));

		expect(harness.accepted).toEqual([]);
	});

	it("statusは接続状態・監視ファイルの状態・起動の回数と最後の時刻をまとめる", () => {
		const harness = createHarness();
		harness.watcher.handle(change("binary_sensor.front_door", "off", "on"));

		expect(harness.watcher.status()).toEqual({
			connection: CONNECTION,
			watchConfig: VALID,
			triggered: { count: 1, lastAt: "2026-11-14T00:00:00.000Z" },
		});
	});
});

function createHarness(options: { config?: WatchConfigState; accept?: boolean } = {}) {
	let now = new Date("2026-11-14T00:00:00.000Z");
	let acceptResult = options.accept ?? true;
	let nextId = 0;
	const accepted: AcceptedConversationEvent[] = [];
	const logger = createRecordingLogger();
	const watcher = new StateChangeWatcher({
		config: { read: () => options.config ?? VALID },
		conversation: {
			accept: vi.fn((input: AcceptedConversationEvent) => {
				if (acceptResult) accepted.push(input);
				return acceptResult;
			}),
		},
		connectionStatus: () => CONNECTION,
		createId: () => `id-${String(++nextId)}`,
		logger,
		now: () => now,
	});
	return {
		accepted,
		logger,
		watcher,
		acceptNext: (value: boolean): void => {
			acceptResult = value;
		},
		advance: (milliseconds: number): void => {
			now = new Date(now.getTime() + milliseconds);
		},
	};
}

function change(entityId: string, oldValue: string, newValue: string): StateChange {
	const state = (value: string) => ({
		entityId,
		state: value,
		attributes: {},
		lastChanged: "2026-11-14T00:00:00.000Z",
		lastUpdated: "2026-11-14T00:00:00.000Z",
	});
	return { entityId, oldState: state(oldValue), newState: state(newValue) };
}
