import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { Transcription } from "../ports/transcriber-port";
import type { Turn } from "./turn-tracker";
import { TurnTracker } from "./turn-tracker";

const TURN_WAIT_MS = 500;
const UNFINISHED_TURN_WAIT_MS = 3000;
const SILENCE_MS = 800;

const heard = (text: string, nonVerbal = false): Transcription => ({
	text,
	nonVerbal,
	elapsedMs: 120,
});
const samples = (...values: number[]): Float32Array => Float32Array.from(values);

function setup() {
	const logger = createRecordingLogger();
	const clock = { now: 10_000 };
	const transcribe = vi.fn<(samples: Float32Array) => Promise<Transcription>>();
	const speakerName = vi.fn(async (userId: string) => `話者${userId}`);
	const drafts: Turn[] = [];
	const commits: Turn[] = [];
	const discards: string[] = [];
	const tracker = new TurnTracker(
		{
			transcriber: { transcribe },
			speakerName,
			logger,
			now: () => clock.now,
			silenceMs: SILENCE_MS,
			turnWaitMs: TURN_WAIT_MS,
			unfinishedTurnWaitMs: UNFINISHED_TURN_WAIT_MS,
		},
		{
			onDraft: (turn) => drafts.push(turn),
			onCommit: (turn) => commits.push(turn),
			onDiscard: (userId) => discards.push(userId),
		},
	);
	return { tracker, transcribe, speakerName, logger, clock, drafts, commits, discards };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("TurnTracker", () => {
	it("区切りを認識すると下書きを渡し、turnWaitMs の間続きがなければ同じターンを確定する", async () => {
		const { tracker, transcribe, logger, drafts, commits } = setup();
		transcribe.mockResolvedValueOnce(heard("こんにちは。"));

		await tracker.segment("1", new Float32Array(8000));

		const expected: Turn = {
			userId: "1",
			speaker: "話者1",
			text: "こんにちは。",
			version: 1,
			speechEndedAt: 10_000 - SILENCE_MS,
			sttMs: 120,
		};
		expect(drafts).toEqual([expected]);
		expect(tracker.idle).toBe(false);
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS - 1);
		expect(commits).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(commits).toEqual([expected]);
		expect(tracker.idle).toBe(true);
		expect(logger.entries).toContainEqual(
			expect.objectContaining({
				event: "voice.segment.transcribed",
				details: { userId: "1", durationSec: 0.5, sttMs: 120, chars: 6, nonVerbal: false },
			}),
		);
	});

	it("文が途中に見えるときは unfinishedTurnWaitMs まで確定を待つ", async () => {
		const { tracker, transcribe, commits } = setup();
		transcribe.mockResolvedValueOnce(heard("駅に着いたんだけど"));

		await tracker.segment("1", samples(0.1));
		await vi.advanceTimersByTimeAsync(UNFINISHED_TURN_WAIT_MS - 1);
		expect(commits).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		expect(commits).toMatchObject([{ text: "駅に着いたんだけど" }]);
	});

	it("確定前に続きの区切りが来たら音声をつないで認識し直し、版を上げて待ち直す", async () => {
		const { tracker, transcribe, clock, drafts, commits } = setup();
		transcribe.mockResolvedValueOnce(heard("駅に")).mockResolvedValueOnce(heard("駅に着いた。"));

		await tracker.segment("1", samples(0.1, 0.2));
		await vi.advanceTimersByTimeAsync(300);
		clock.now = 20_000;
		await tracker.segment("1", samples(0.3));

		expect(transcribe).toHaveBeenLastCalledWith(samples(0.1, 0.2, 0.3));
		expect(drafts).toMatchObject([
			{ text: "駅に", version: 1 },
			{ text: "駅に着いた。", version: 2, speechEndedAt: 20_000 - SILENCE_MS },
		]);
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS - 1);
		expect(commits).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(commits).toMatchObject([{ text: "駅に着いた。", version: 2 }]);
	});

	it("話し始めたら確定待ちを止め、次の区切りまで確定しない", async () => {
		const { tracker, transcribe, commits } = setup();
		transcribe.mockResolvedValueOnce(heard("あの")).mockResolvedValueOnce(heard("あの、明日。"));

		await tracker.segment("1", samples(0.1));
		tracker.speechStarted("1");
		await vi.advanceTimersByTimeAsync(UNFINISHED_TURN_WAIT_MS * 10);

		expect(commits).toEqual([]);
		expect(tracker.idle).toBe(false);
		await tracker.segment("1", samples(0.2));
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);
		expect(commits).toMatchObject([{ text: "あの、明日。", version: 2 }]);
	});

	it("認識の途中で話し始めたら、認識が返っても確定待ちを始めない", async () => {
		const { tracker, transcribe, drafts, commits } = setup();
		const result = Promise.withResolvers<Transcription>();
		transcribe.mockReturnValueOnce(result.promise);

		const segment = tracker.segment("1", samples(0.1));
		tracker.speechStarted("1");
		result.resolve(heard("はい。"));
		await segment;
		await vi.advanceTimersByTimeAsync(UNFINISHED_TURN_WAIT_MS * 10);

		expect(drafts).toMatchObject([{ text: "はい。" }]);
		expect(commits).toEqual([]);
	});

	it("待っている話者がいなければ speechStarted は何もしない", async () => {
		const { tracker } = setup();

		tracker.speechStarted("1");

		expect(tracker.idle).toBe(true);
	});

	it.each([
		["空の文字起こし", heard("")],
		["声以外の音", heard("(笑)", true)],
	])("%sだけの話者はターンを確定せず onDiscard を呼ぶ", async (_, result) => {
		const { tracker, transcribe, drafts, commits, discards } = setup();
		transcribe.mockResolvedValueOnce(result);

		await tracker.segment("1", samples(0.1));
		await vi.advanceTimersByTimeAsync(UNFINISHED_TURN_WAIT_MS);

		expect(drafts).toEqual([]);
		expect(commits).toEqual([]);
		expect(discards).toEqual(["1"]);
		expect(tracker.idle).toBe(true);
	});

	it.each([
		["空の文字起こし", heard("")],
		["声以外の音", heard("(笑)", true)],
	])("下書きの後の%sはターンに何も足さず、前の内容を確定する", async (_, result) => {
		const { tracker, transcribe, drafts, commits, discards } = setup();
		transcribe.mockResolvedValueOnce(heard("はい。")).mockResolvedValueOnce(result);

		await tracker.segment("1", samples(0.1));
		await tracker.segment("1", samples(0.2));
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);

		expect(drafts).toHaveLength(1);
		expect(commits).toMatchObject([{ text: "はい。", version: 1 }]);
		expect(discards).toEqual([]);
	});

	it("古い区切りの認識が後から返っても、新しい区切りの結果を上書きしない", async () => {
		const { tracker, transcribe, drafts, commits } = setup();
		const first = Promise.withResolvers<Transcription>();
		const second = Promise.withResolvers<Transcription>();
		transcribe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const firstSegment = tracker.segment("1", samples(0.1));
		const secondSegment = tracker.segment("1", samples(0.2));
		second.resolve(heard("駅に着いた。"));
		await secondSegment;
		first.resolve(heard("駅"));
		await firstSegment;
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);

		expect(drafts).toMatchObject([{ text: "駅に着いた。", version: 2 }]);
		expect(commits).toMatchObject([{ text: "駅に着いた。", version: 2 }]);
	});

	it("話者ごとに別々に待ち、ほかの話者の区切りでは確定待ちを延ばさない", async () => {
		const { tracker, transcribe, commits } = setup();
		transcribe.mockResolvedValueOnce(heard("一。")).mockResolvedValueOnce(heard("二。"));

		await tracker.segment("1", samples(0.1));
		await vi.advanceTimersByTimeAsync(300);
		await tracker.segment("2", samples(0.2));
		await vi.advanceTimersByTimeAsync(200);

		expect(commits).toMatchObject([{ userId: "1", speaker: "話者1", text: "一。" }]);
		await vi.advanceTimersByTimeAsync(300);
		expect(commits).toMatchObject([{ userId: "1" }, { userId: "2", speaker: "話者2" }]);
	});

	it("最初の区切りの認識に失敗したら失敗を返し、その話者を待たない", async () => {
		const { tracker, transcribe, drafts, discards } = setup();
		transcribe.mockRejectedValueOnce(new Error("stt down"));

		await expect(tracker.segment("1", samples(0.1))).rejects.toThrow("stt down");

		expect(drafts).toEqual([]);
		expect(discards).toEqual(["1"]);
		expect(tracker.idle).toBe(true);
	});

	it("続きの区切りの認識に失敗しても、前の内容のターンは確定する", async () => {
		const { tracker, transcribe, commits } = setup();
		transcribe.mockResolvedValueOnce(heard("はい。")).mockRejectedValueOnce(new Error("stt down"));

		await tracker.segment("1", samples(0.1));
		await expect(tracker.segment("1", samples(0.2))).rejects.toThrow("stt down");
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);

		expect(commits).toMatchObject([{ text: "はい。", version: 1 }]);
		expect(tracker.idle).toBe(true);
	});

	it("話者名の取得に失敗しても、その話者を待ったままにしない", async () => {
		const { tracker, transcribe, speakerName, discards } = setup();
		transcribe.mockResolvedValueOnce(heard("はい。"));
		speakerName.mockRejectedValueOnce(new Error("discord down"));

		await expect(tracker.segment("1", samples(0.1))).rejects.toThrow("discord down");

		expect(discards).toEqual(["1"]);
		expect(tracker.idle).toBe(true);
	});

	it("dispose で確定待ちを捨て、認識中だった区切りの結果も使わない", async () => {
		const { tracker, transcribe, drafts, commits } = setup();
		const late = Promise.withResolvers<Transcription>();
		transcribe.mockResolvedValueOnce(heard("一。")).mockReturnValueOnce(late.promise);

		await tracker.segment("1", samples(0.1));
		const pending = tracker.segment("2", samples(0.2));
		tracker.dispose();
		late.resolve(heard("二。"));
		await pending;
		await vi.advanceTimersByTimeAsync(UNFINISHED_TURN_WAIT_MS);

		expect(drafts).toMatchObject([{ text: "一。" }]);
		expect(commits).toEqual([]);
		expect(tracker.idle).toBe(true);
	});
});
