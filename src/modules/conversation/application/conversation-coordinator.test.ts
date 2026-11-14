import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { formatLocalDate } from "../../../shared/local-date";
import type {
	AgentInputMessage,
	AgentRunResult,
	AgentSession,
	AgentSessionPhase,
	ModelSelection,
} from "../../agent/ports/outbound/agent-session-port";
import { createFakeBackground } from "../../agent/testing/fake-background";
import type { FakeBackground } from "../../agent/testing/fake-background";
import type { LunaEvent } from "../../event/domain/luna-event";
import type { LogEntry, LoggerPort } from "../../observability/ports/logger-port";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { OpenAgentSession } from "../../tool/ports/agent-session-factory-port";
import type { ConversationSession } from "../domain/conversation-session";
import type { ConversationHistoryPort } from "../ports/conversation-history-port";
import type { ConversationIntentPort } from "../ports/conversation-intent-port";
import { ConversationCoordinator } from "./conversation-coordinator";

const session: ConversationSession = {
	key: "discord:guild_channel:300:200",
	source: "discord/main",
	context: { kind: "guild_channel", guildId: "300", channelId: "200" },
};
const COMPLETED: AgentRunResult = { status: "completed", finalText: null };
const SOL: ModelSelection = { provider: "openai-codex", model: "gpt-6-sol", thinking: "medium" };
const ASTRA: ModelSelection = { provider: "openai-codex", model: "gpt-6-astra", thinking: "high" };

afterEach(() => {
	vi.useRealTimers();
});

describe("ConversationCoordinator", () => {
	describe("受付", () => {
		it("受理した入力にtrue、intake停止後の入力と操作にfalseを返す", async () => {
			const harness = createHarness();

			expect(harness.accept("100", "2026-07-23T00:00:00.000Z")).toBe(true);
			harness.coordinator.stopIntake();

			expect(harness.accept("101", "2026-07-23T00:00:01.000Z")).toBe(false);
			expect(harness.coordinator.configure(session, SOL)).toBe(false);
			expect(harness.coordinator.endSession(session.key)).toBe(false);
		});

		it("debounceの待機時間はセッションごとに決め、0ならすぐに実行を始める", async () => {
			const debounceMs = vi.fn(() => 0);
			const harness = createHarness({ debounceMs });

			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.advance(0);

			expect(debounceMs).toHaveBeenCalledWith(session);
			expect(harness.openSession).toHaveBeenCalledOnce();
		});

		it("debounce後にhistoryとoccurredAt・id順のbatch、task一覧を新しいセッションへ渡す", async () => {
			const historyEvent = event("90", "2026-07-23T00:00:00.000Z");
			const fetchBefore = vi.fn<ConversationHistoryPort["fetchBefore"]>(async () => [
				event("101", "2026-07-23T00:00:02.000Z"),
				historyEvent,
			]);
			const harness = createHarness({ history: { fetchBefore } });

			harness.accept("102", "2026-07-23T09:00:01.000+09:00");
			harness.accept("101", "2026-07-23T00:00:02.000Z");
			harness.accept("100", "2026-07-23T09:00:02.000+09:00");
			await harness.advance(99);
			expect(harness.openSession).not.toHaveBeenCalled();
			await harness.advance(1);

			expect(harness.openSession).toHaveBeenCalledExactlyOnceWith(
				{ kind: "conversation", session },
				undefined,
			);
			expect(fetchBefore).toHaveBeenCalledWith(
				session,
				event("102", "2026-07-23T09:00:01.000+09:00"),
				20,
			);
			expect(harness.listFor).toHaveBeenCalledWith(session);
			expect(harness.runs[0]?.messages).toEqual([
				{ kind: "history", text: JSON.stringify([historyEvent]) },
				eventMessage(event("102", "2026-07-23T09:00:01.000+09:00")),
				eventMessage(event("100", "2026-07-23T09:00:02.000+09:00")),
				eventMessage(event("101", "2026-07-23T00:00:02.000Z")),
				{ kind: "task_board", text: JSON.stringify([{ id: "task-1", status: "running" }]) },
			]);
		});

		it("新着に反応した予定を、新着の後・タスク一覧の前に渡す", async () => {
			const match = vi.fn<ConversationIntentPort["match"]>((events) =>
				events.some((candidate) => candidate.id === "101") ? [{ kind: "intent", text: "I" }] : [],
			);
			const harness = createHarness({ intents: { match } });

			harness.accept("100", "2026-07-23T00:00:00.000Z");
			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.advance(100);

			expect(harness.runs[0]?.messages).toEqual([
				eventMessage(event("100", "2026-07-23T00:00:00.000Z")),
				eventMessage(event("101", "2026-07-23T00:00:01.000Z")),
				{ kind: "intent", text: "I" },
				{ kind: "task_board", text: JSON.stringify([{ id: "task-1", status: "running" }]) },
			]);
		});

		it("debounce中の新着でdebounceを延長する", async () => {
			const harness = createHarness();

			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.advance(80);
			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.advance(99);
			expect(harness.openSession).not.toHaveBeenCalled();
			await harness.advance(1);

			expect(
				harness.runs[0]?.messages.filter((message) => message.kind === "discord_message"),
			).toHaveLength(2);
		});

		it("初回履歴が空ならhistory入力を省き、取得に失敗したら記録して履歴なしで始める", async () => {
			const failure = new Error("history failed");
			const history: ConversationHistoryPort = {
				fetchBefore: vi.fn<ConversationHistoryPort["fetchBefore"]>(async () => {
					throw failure;
				}),
			};
			const harness = createHarness({ history });

			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.advance(100);

			expect(harness.runs[0]?.messages.map((message) => message.kind)).toEqual([
				"discord_message",
				"task_board",
			]);
			expect(harness.logs).toContainEqual(operationFailed("history/fetch", failure));
		});

		it("最初のイベントより前に始まったtypingが途切れるまでbatchを待つ", async () => {
			const harness = createHarness();

			harness.coordinator.typing(session, "400");
			expect(harness.coordinator.hasSession(session.key)).toBe(false);
			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.advance(80);
			harness.coordinator.typing(session, "400");
			await harness.advance(20);
			expect(harness.openSession).not.toHaveBeenCalled();
			await harness.advance(30);

			expect(harness.openSession).toHaveBeenCalledOnce();
		});

		it("typingだけでイベントが来なければセッションを作らずに片付ける", async () => {
			const harness = createHarness();

			harness.coordinator.typing(session, "400");
			await harness.advance(50);

			expect(harness.coordinator.snapshot()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
			expect(harness.openSession).not.toHaveBeenCalled();
		});
	});

	describe("実行中の新着", () => {
		it("実行中の投稿を受信順に一件ずつsteerし、完了時にbatchと合わせて成功を通知する", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");

			harness.accept("101", "2026-07-23T00:00:01.000Z");
			harness.accept("102", "2026-07-23T00:00:02.000Z");
			await harness.flush();

			expect(harness.sessions[0]?.steer.mock.calls).toEqual([
				[eventMessage(event("101", "2026-07-23T00:00:01.000Z"))],
				[eventMessage(event("102", "2026-07-23T00:00:02.000Z"))],
			]);
			expect(harness.onBatchSettled).not.toHaveBeenCalled();
			harness.finishRun(0);
			await harness.flush();

			expect(harness.onBatchSettled).toHaveBeenCalledExactlyOnceWith(["100", "101", "102"], true);
			expect(harness.runs).toHaveLength(1);
		});

		it("実行中の新着に反応した予定も、その新着の直後にsteerする", async () => {
			const harness = createHarness({
				intents: {
					match: (events) =>
						events.some((candidate) => candidate.id === "101")
							? [{ kind: "intent", text: "I" }]
							: [],
				},
			});
			await harness.startFirstRun("100");

			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.flush();

			expect(harness.sessions[0]?.steer.mock.calls).toEqual([
				[eventMessage(event("101", "2026-07-23T00:00:01.000Z"))],
				[{ kind: "intent", text: "I" }],
			]);
		});

		it("セッションを開いている間の新着は、最初の実行の完了後に同じセッションで続けて実行する", async () => {
			const harness = createHarness();
			const opening = createDeferred<void>();
			harness.openSession.mockImplementationOnce(async (origin, model) => {
				await opening.promise;
				return harness.createSession(origin, model);
			});
			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.advance(100);

			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.flush();
			expect(harness.coordinator.snapshot()).toMatchObject([{ phase: "opening", queuedEvents: 2 }]);
			opening.resolve();
			await harness.flush();
			expect(harness.runs).toHaveLength(1);
			harness.finishRun(0);
			await harness.flush();

			expect(harness.runs[1]).toEqual({
				sessionId: "session-1",
				messages: [
					eventMessage(event("101", "2026-07-23T00:00:01.000Z")),
					{ kind: "task_board", text: JSON.stringify([{ id: "task-1", status: "running" }]) },
				],
			});
			expect(harness.openSession).toHaveBeenCalledOnce();
		});

		it("実行の完了ごとにツールを解放し、セッションは開いたままidleにする", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");

			harness.finishRun(0);
			await harness.flush();

			expect(harness.releaseTools).toHaveBeenCalledWith("owner-1");
			expect(harness.sessions[0]?.close).not.toHaveBeenCalled();
			expect(harness.coordinator.snapshot()).toMatchObject([{ phase: "idle" }]);
		});
	});

	describe("バックグラウンド実行", () => {
		const taskBoard: AgentInputMessage = {
			kind: "task_board",
			text: JSON.stringify([{ id: "task-1", status: "running" }]),
		};

		it("残っている間はidle期限を数えず、完了通知を受けて同じセッションでタスク一覧を渡して実行する", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");
			harness.sessions[0]?.background.start();
			harness.finishRun(0);
			await harness.flush();

			await harness.advance(5_000);
			expect(harness.sessions[0]?.close).not.toHaveBeenCalled();
			expect(harness.coordinator.snapshot()).toMatchObject([
				{ phase: "idle", idleDeadlineAt: null },
			]);

			harness.sessions[0]?.background.settle(true);
			await harness.flush();
			expect(harness.runs[1]).toEqual({ sessionId: "session-1", messages: [taskBoard] });
			harness.finishRun(1);
			await harness.flush();

			await harness.advance(999);
			expect(harness.sessions[0]?.close).not.toHaveBeenCalled();
			await harness.advance(1);
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
		});

		it("通知なしにすべて止まったらidle期限を数え始める", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");
			harness.sessions[0]?.background.start();
			harness.finishRun(0);
			await harness.flush();

			harness.sessions[0]?.background.settle(false);
			await harness.flush();
			await harness.advance(999);
			expect(harness.sessions[0]?.close).not.toHaveBeenCalled();
			await harness.advance(1);

			expect(harness.runs).toHaveLength(1);
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
		});

		it("待っている間の新着を先に処理し、その実行中に届いた通知は実行の完了後に続けて渡す", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");
			harness.sessions[0]?.background.start();
			harness.finishRun(0);
			await harness.flush();

			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.advance(100);
			expect(harness.runs[1]?.messages[0]?.kind).toBe("discord_message");
			harness.sessions[0]?.background.settle(true);
			await harness.flush();
			expect(harness.runs).toHaveLength(2);

			harness.finishRun(1);
			await harness.flush();
			expect(harness.runs[2]).toEqual({ sessionId: "session-1", messages: [taskBoard] });
		});

		it("終了要求では記憶保存の前に止める", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");
			harness.sessions[0]?.background.start();
			harness.finishRun(0);
			await harness.flush();

			expect(harness.coordinator.endSession(session.key)).toBe(true);
			await harness.flush();

			expect(harness.sessions[0]?.stopBackground).toHaveBeenCalledOnce();
			expect(harness.runs[1]?.messages[0]?.kind).toBe("session_end");
			harness.finishRun(1);
			await harness.flush();
			expect(harness.runs).toHaveLength(2);
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
		});
	});

	describe("アイドル終了と記憶保存", () => {
		it("idle期限で同じセッションに記憶保存を実行し、完了後に閉じて一覧から外す", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();

			await harness.advance(999);
			expect(harness.runs).toHaveLength(1);
			await harness.advance(1);

			expect(harness.runs[1]).toEqual({
				sessionId: "session-1",
				messages: [
					{ kind: "session_end", text: JSON.stringify({ date: formatLocalDate(new Date()) }) },
				],
			});
			expect(harness.coordinator.snapshot()).toMatchObject([
				{ phase: "running", purpose: "session_memory" },
			]);
			harness.finishRun(1);
			await harness.flush();

			expect(harness.calls).toEqual([
				"release:owner-1",
				"release:owner-1",
				"release:owner-1",
				"close:session-1",
			]);
			expect(harness.coordinator.snapshot()).toEqual([]);
			expect(harness.coordinator.hasSession(session.key)).toBe(false);
		});

		it("記憶保存が無効ならidle期限で記憶保存せずに閉じる", async () => {
			const harness = createHarness({ sessionMemoryEnabled: false });
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();

			await harness.advance(1_000);

			expect(harness.runs).toHaveLength(1);
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
			expect(harness.coordinator.snapshot()).toEqual([]);
		});

		it("idle中の新着でidle期限を取り消し、次の実行の完了後から待ち直す", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();

			await harness.advance(900);
			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.advance(100);
			expect(harness.runs).toHaveLength(2);
			expect(harness.runs[1]?.sessionId).toBe("session-1");
			await harness.advance(5_000);
			expect(harness.sessions[0]?.close).not.toHaveBeenCalled();
			harness.finishRun(1);
			await harness.flush();

			await harness.advance(999);
			expect(harness.sessions[0]?.close).not.toHaveBeenCalled();
			await harness.advance(1);
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
		});

		it("記憶保存の実行中の新着を、閉じた後の新しいセッションへ渡す", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();
			await harness.advance(1_000);

			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.flush();
			expect(harness.sessions[0]?.steer).not.toHaveBeenCalled();
			expect(harness.coordinator.configure(session, SOL)).toBe(false);
			harness.finishRun(1);
			await harness.flush();

			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
			expect(harness.openSession).toHaveBeenCalledTimes(2);
			expect(harness.runs[2]?.sessionId).toBe("session-2");
			expect(harness.runs[2]?.messages[0]).toEqual(
				eventMessage(event("101", "2026-07-23T00:00:01.000Z")),
			);
		});

		it("記憶保存の失敗を記録して閉じる", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();
			await harness.advance(1_000);

			harness.finishRun(1, { status: "failed", reason: "fatal", message: "boom" });
			await harness.flush();

			expect(harness.logs).toContainEqual(operationFailed("session/run"));
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
			expect(harness.coordinator.snapshot()).toEqual([]);
		});
	});

	describe("/luna end", () => {
		it("セッションがなければ終了を受け付けない", () => {
			const harness = createHarness();

			expect(harness.coordinator.endSession(session.key)).toBe(false);
		});

		it("idle中の終了要求ですぐに記憶保存して閉じる", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();

			expect(harness.coordinator.endSession(session.key)).toBe(true);
			await harness.flush();
			expect(harness.runs[1]?.messages[0]?.kind).toBe("session_end");
			harness.finishRun(1);
			await harness.flush();

			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
			expect(harness.coordinator.hasSession(session.key)).toBe(false);
		});

		it("実行中の終了要求は実行を中断せず、完了後に記憶保存し、新着は次のセッションへ渡す", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");

			expect(harness.coordinator.endSession(session.key)).toBe(true);
			expect(harness.coordinator.configure(session, SOL)).toBe(false);
			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.flush();
			expect(harness.sessions[0]?.abort).not.toHaveBeenCalled();
			expect(harness.sessions[0]?.steer).not.toHaveBeenCalled();

			harness.finishRun(0);
			await harness.flush();
			expect(harness.runs[1]?.messages[0]?.kind).toBe("session_end");
			harness.finishRun(1);
			await harness.flush();

			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
			expect(harness.runs[2]?.sessionId).toBe("session-2");
			expect(harness.runs[2]?.messages[0]).toEqual(
				eventMessage(event("101", "2026-07-23T00:00:01.000Z")),
			);
			expect(harness.coordinator.configure(session, SOL)).toBe(true);
		});

		it("debounce中の終了要求でモデル設定を破棄し、待っていたbatchは既定のモデルで開いたセッションで処理する", async () => {
			const harness = createHarness();
			harness.coordinator.configure(session, SOL);
			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.flush();

			expect(harness.coordinator.endSession(session.key)).toBe(true);
			await harness.flush();

			expect(harness.openSession).toHaveBeenCalledExactlyOnceWith(
				{ kind: "conversation", session },
				undefined,
			);
			expect(harness.runs[0]?.messages[0]).toEqual(
				eventMessage(event("100", "2026-07-23T00:00:00.000Z")),
			);
		});
	});

	describe("停止", () => {
		it("drainは実行中の実行を待ち、記憶保存して閉じてから返る", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");

			let drained = false;
			const draining = harness.coordinator.drain().then(() => {
				drained = true;
			});
			await harness.flush();
			expect(harness.accept("101", "2026-07-23T00:00:01.000Z")).toBe(false);
			harness.finishRun(0);
			await harness.flush();
			expect(harness.runs[1]?.messages[0]?.kind).toBe("session_end");
			expect(drained).toBe(false);
			harness.finishRun(1);
			await draining;

			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
			expect(harness.sessions[0]?.abort).not.toHaveBeenCalled();
			expect(harness.coordinator.snapshot()).toEqual([]);
		});

		it("drainはidle期限前のセッションを記憶保存してから閉じる", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();

			const draining = harness.coordinator.drain();
			await harness.flush();
			harness.finishRun(1);
			await draining;

			expect(harness.runs[1]?.messages[0]?.kind).toBe("session_end");
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
		});

		it("drainはdebounce中とtyping待ちのbatchもすぐ処理してから閉じる", async () => {
			const harness = createHarness({ sessionMemoryEnabled: false });
			harness.coordinator.typing(session, "400");
			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.flush();

			const draining = harness.coordinator.drain();
			await harness.flush();
			expect(harness.runs).toHaveLength(1);
			harness.finishRun(0);
			await draining;

			expect(harness.onBatchSettled).toHaveBeenCalledWith(["100"], true);
			expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe("失敗", () => {
		it("セッションを開けなければ記録して失敗を通知し、次の新着で開き直す", async () => {
			const failure = new Error("model unavailable");
			const harness = createHarness();
			harness.openSession.mockRejectedValueOnce(failure);

			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.advance(100);

			expect(harness.logs).toContainEqual(operationFailed("session/open", failure));
			expect(harness.onBatchSettled).toHaveBeenCalledExactlyOnceWith(["100"], false);
			expect(harness.coordinator.snapshot()).toEqual([]);
			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.advance(100);
			expect(harness.runs).toHaveLength(1);
		});

		it.each<[string, (harness: Harness) => void]>([
			[
				"失敗",
				(harness) =>
					harness.finishRun(0, { status: "failed", reason: "usage_limit", message: "limit" }),
			],
			["例外", (harness) => harness.failRun(0, new Error("session crashed"))],
		])(
			"実行の%sを記録し、steerした新着も含めて失敗を通知してセッションを閉じる",
			async (_label, fail) => {
				const harness = createHarness({ sessionMemoryEnabled: true });
				await harness.startFirstRun("100");
				harness.accept("101", "2026-07-23T00:00:01.000Z");
				await harness.flush();

				fail(harness);
				await harness.flush();

				expect(harness.logs).toContainEqual(operationFailed("session/run"));
				expect(harness.onBatchSettled).toHaveBeenCalledExactlyOnceWith(["100", "101"], false);
				expect(harness.sessions[0]?.close).toHaveBeenCalledOnce();
				expect(harness.runs.filter((run) => run.sessionId === "session-1")).toHaveLength(1);
			},
		);

		it("実行の失敗後に受理した新着を新しいセッションで処理する", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");
			harness.finishRun(0, { status: "failed", reason: "fatal", message: "boom" });
			await harness.flush();

			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.advance(100);

			expect(harness.runs[1]?.sessionId).toBe("session-2");
		});

		it("ツール解放とcloseの失敗を記録しても閉じる処理を続ける", async () => {
			const harness = createHarness();
			await harness.startFirstRun("100");
			harness.releaseTools.mockRejectedValue(new Error("release failed"));
			harness.sessions[0]?.close.mockRejectedValueOnce(new Error("close failed"));
			harness.finishRun(0);
			await harness.flush();

			await harness.advance(1_000);

			expect(harness.logs).toContainEqual(operationFailed("tools/release"));
			expect(harness.logs).toContainEqual(operationFailed("session/close"));
			expect(harness.coordinator.snapshot()).toEqual([]);
		});

		it("コマンド処理の例外を記録し、会話を閉じる", async () => {
			const failure = new Error("handler failed");
			const harness = createHarness({
				wrapLogger: (logger) => failingLogger(logger, "conversation.session_opened", failure),
			});

			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.advance(100);

			expect(harness.logs).toContainEqual(operationFailed("actor/mailbox", failure));
			expect(harness.coordinator.hasSession(session.key)).toBe(false);
			expect(harness.onBatchSettled).toHaveBeenCalledExactlyOnceWith(["100"], false);
		});
	});

	describe("モデル設定", () => {
		it("設定コマンドでセッションを作り、投稿がなければidle期限でセッションを開かずに閉じる", async () => {
			const harness = createHarness({ sessionMemoryEnabled: true });

			expect(harness.coordinator.configure(session, SOL)).toBe(true);
			await harness.flush();
			expect(harness.coordinator.hasSession(session.key)).toBe(true);
			expect(harness.coordinator.snapshot()).toMatchObject([{ phase: "idle", modelSettings: SOL }]);
			await harness.advance(999);
			expect(harness.coordinator.hasSession(session.key)).toBe(true);
			await harness.advance(1);

			expect(harness.coordinator.hasSession(session.key)).toBe(false);
			expect(harness.openSession).not.toHaveBeenCalled();
		});

		it("設定したモデルでセッションを開き、開いた後の設定はセッションへ即時適用する", async () => {
			const harness = createHarness();

			harness.coordinator.configure(session, SOL);
			await harness.startFirstRun("100");
			expect(harness.openSession).toHaveBeenCalledWith({ kind: "conversation", session }, SOL);

			harness.coordinator.configure(session, ASTRA);
			await harness.flush();

			expect(harness.sessions[0]?.setModel).toHaveBeenCalledExactlyOnceWith(ASTRA);
			expect(harness.coordinator.snapshot()).toMatchObject([{ modelSettings: ASTRA }]);
		});

		it("セッションを閉じたら設定を破棄し、次のセッションは既定のモデルで開く", async () => {
			const harness = createHarness();
			harness.coordinator.configure(session, SOL);
			await harness.startFirstRun("100");
			harness.finishRun(0);
			await harness.flush();
			await harness.advance(1_000);

			harness.accept("101", "2026-07-23T00:00:01.000Z");
			await harness.advance(100);

			expect(harness.openSession).toHaveBeenLastCalledWith(
				{ kind: "conversation", session },
				undefined,
			);
		});
	});

	describe("一覧", () => {
		it("フェーズと開始時刻、待機件数、セッションID、idle期限を一覧し、閉じたら外す", async () => {
			const harness = createHarness();

			harness.accept("100", "2026-07-23T00:00:00.000Z");
			await harness.flush();
			expect(harness.coordinator.snapshot()).toEqual([
				{
					context: session.context,
					idleDeadlineAt: null,
					key: session.key,
					modelSettings: null,
					phase: "collecting",
					phaseSince: "2026-07-23T00:00:00.000Z",
					purpose: null,
					queuedEvents: 1,
					retries: 0,
					sessionId: null,
					source: session.source,
				},
			]);

			await harness.advance(100);
			expect(harness.coordinator.snapshot()).toMatchObject([
				{
					phase: "running",
					phaseSince: "2026-07-23T00:00:00.100Z",
					purpose: "conversation",
					queuedEvents: 0,
					sessionId: "session-1",
				},
			]);
			harness.sessions[0]?.setPhase("retry_wait", 2);
			expect(harness.coordinator.snapshot()).toMatchObject([{ phase: "retry_wait", retries: 2 }]);
			harness.sessions[0]?.setPhase("compacting", 0);
			expect(harness.coordinator.snapshot()).toMatchObject([{ phase: "compacting" }]);

			harness.finishRun(0);
			await harness.flush();
			expect(harness.coordinator.snapshot()).toMatchObject([
				{ phase: "idle", idleDeadlineAt: "2026-07-23T00:00:01.100Z", sessionId: "session-1" },
			]);

			await harness.advance(1_000);
			expect(harness.coordinator.snapshot()).toEqual([]);
		});
	});
});

type Harness = ReturnType<typeof createHarness>;
type RecordedRun = { sessionId: string; messages: readonly AgentInputMessage[] };
type FakeSession = {
	readonly id: string;
	run: Mock<AgentSession["run"]>;
	steer: Mock<AgentSession["steer"]>;
	abort: Mock<AgentSession["abort"]>;
	hasBackground: Mock<AgentSession["hasBackground"]>;
	waitForBackground: Mock<AgentSession["waitForBackground"]>;
	stopBackground: Mock<AgentSession["stopBackground"]>;
	setModel: Mock<AgentSession["setModel"]>;
	close: Mock<AgentSession["close"]>;
	status: Mock<AgentSession["status"]>;
	setPhase(phase: AgentSessionPhase, retries: number): void;
	background: FakeBackground;
};

function createHarness(
	options: {
		history?: ConversationHistoryPort;
		intents?: ConversationIntentPort;
		wrapLogger?: (logger: LoggerPort) => LoggerPort;
		sessionMemoryEnabled?: boolean;
		debounceMs?: (session: ConversationSession) => number;
	} = {},
) {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
	const calls: string[] = [];
	const runs: RecordedRun[] = [];
	const settlers: Array<{ resolve(result: AgentRunResult): void; reject(error: unknown): void }> =
		[];
	const sessions: FakeSession[] = [];

	function createSession(
		_origin: Parameters<OpenAgentSession>[0],
		model?: ModelSelection,
	): { ownerId: string; session: FakeSession } {
		const index = sessions.length + 1;
		const id = `session-${String(index)}`;
		const state: { phase: AgentSessionPhase; retries: number } = { phase: "idle", retries: 0 };
		const background = createFakeBackground();
		const fake: FakeSession = {
			id,
			setPhase: (phase: AgentSessionPhase, retries: number): void => {
				state.phase = phase;
				state.retries = retries;
			},
			background,
			run: vi.fn<AgentSession["run"]>(
				async (messages) =>
					await new Promise<AgentRunResult>((resolve, reject) => {
						background.consume();
						runs.push({ sessionId: id, messages });
						settlers.push({ resolve, reject });
					}),
			),
			hasBackground: background.hasBackground,
			waitForBackground: background.waitForBackground,
			stopBackground: background.stopBackground,
			steer: vi.fn<AgentSession["steer"]>(),
			abort: vi.fn<AgentSession["abort"]>(async () => {
				const runIndex = runs.findLastIndex((run) => run.sessionId === id);
				settlers[runIndex]?.resolve({ status: "aborted" });
			}),
			setModel: vi.fn<AgentSession["setModel"]>(),
			close: vi.fn<AgentSession["close"]>(async () => {
				calls.push(`close:${id}`);
			}),
			status: vi.fn<AgentSession["status"]>(() => ({
				id,
				kind: "conversation",
				label: session.key,
				model: model ?? SOL,
				phase: state.phase,
				phaseSince: "2026-07-23T00:00:00.000Z",
				retries: state.retries,
			})),
		};
		sessions.push(fake);
		return { ownerId: `owner-${String(index)}`, session: fake };
	}

	const openSession: Mock<OpenAgentSession> = vi.fn(async (origin, model) =>
		createSession(origin, model),
	);
	const releaseTools = vi.fn(async (ownerId: string) => {
		calls.push(`release:${ownerId}`);
	});
	const logger = createRecordingLogger();
	const onBatchSettled = vi.fn<(eventIds: readonly string[], succeeded: boolean) => void>();
	const listFor = vi.fn(() => [{ id: "task-1", status: "running" }]);
	const coordinator = new ConversationCoordinator(
		{
			history: options.history ?? { fetchBefore: vi.fn(async () => []) },
			intents: options.intents ?? { match: () => [] },
			logger: options.wrapLogger?.(logger) ?? logger,
			now: () => new Date(),
			onBatchSettled,
			openSession,
			releaseTools,
			tasks: { listFor },
		},
		{
			debounceMs: options.debounceMs ?? (() => 100),
			initialHistoryLimit: 20,
			sessionIdleMs: 1_000,
			sessionMemoryEnabled: options.sessionMemoryEnabled ?? false,
			typingIdleMs: 50,
		},
	);

	const flush = async (): Promise<void> => {
		for (let index = 0; index < 5; index += 1) await vi.advanceTimersByTimeAsync(0);
	};
	const harness = {
		accept: (id: string, occurredAt: string): boolean =>
			coordinator.accept({ session, event: event(id, occurredAt) }),
		advance: async (milliseconds: number): Promise<void> => {
			await vi.advanceTimersByTimeAsync(milliseconds);
			await flush();
		},
		calls,
		coordinator,
		createSession,
		failRun: (index: number, error: Error): void => {
			const settler = settlers[index];
			if (settler === undefined) throw new Error(`run ${String(index)} is missing`);
			settler.reject(error);
		},
		finishRun: (index: number, result: AgentRunResult = COMPLETED): void => {
			const settler = settlers[index];
			if (settler === undefined) throw new Error(`run ${String(index)} is missing`);
			settler.resolve(result);
		},
		flush,
		listFor,
		logs: logger.entries,
		onBatchSettled,
		openSession,
		releaseTools,
		runs,
		sessions,
		startFirstRun: async (id: string): Promise<void> => {
			harness.accept(id, "2026-07-23T00:00:00.000Z");
			await harness.advance(100);
			expect(runs).toHaveLength(1);
		},
	};
	return harness;
}

function event(id: string, occurredAt: string): LunaEvent {
	return {
		id,
		type: "discord.message.created.v1",
		source: session.source,
		subject: session.key,
		occurredAt,
		data: { value: id },
	};
}

function eventMessage(input: LunaEvent): AgentInputMessage {
	return { kind: "discord_message", text: JSON.stringify(input) };
}

function operationFailed(operation: string, error: unknown = expect.any(Error)): LogEntry {
	return {
		level: "error",
		event: "conversation.operation_failed",
		context: { conversationSession: session.key },
		details: { error, operation },
	};
}

function failingLogger(logger: LoggerPort, failingEvent: string, error: Error): LoggerPort {
	const guard =
		(method: LoggerPort["info"]): LoggerPort["info"] =>
		(name, details, payload) => {
			if (name === failingEvent) throw error;
			method(name, details, payload);
		};
	return {
		child: (context) => failingLogger(logger.child(context), failingEvent, error),
		info: guard(logger.info),
		warn: guard(logger.warn),
		error: guard(logger.error),
	};
}

function createDeferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
