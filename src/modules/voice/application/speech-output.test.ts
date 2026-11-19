import { describe, expect, it, vi } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { VoicePcm } from "../ports/speech-port";
import { SpeechOutput } from "./speech-output";

const settle = (): Promise<void> =>
	new Promise((resolve) => {
		setImmediate(resolve);
	});

function setup() {
	const logger = createRecordingLogger();
	const clock = { now: 0 };
	const held = new Map<string, PromiseWithResolvers<void>>();
	const failing = new Set<string>();
	const synthesize = vi.fn(async (text: string): Promise<VoicePcm> => {
		await held.get(text)?.promise;
		if (failing.has(text)) throw new Error("tts down");
		return { pcm: Buffer.from(text) };
	});
	const hold = (text: string): PromiseWithResolvers<void> => {
		const gate = Promise.withResolvers<void>();
		held.set(text, gate);
		return gate;
	};

	let current: PromiseWithResolvers<boolean> | undefined;
	const playback = {
		play: vi.fn((_audio: VoicePcm): Promise<boolean> => {
			current = Promise.withResolvers<boolean>();
			return current.promise;
		}),
		stop: vi.fn(() => {
			current?.resolve(false);
			current = undefined;
		}),
		setVolume: vi.fn(),
	};
	const played = (): string[] => playback.play.mock.calls.map(([audio]) => audio.pcm.toString());
	const endPlaying = async (completed = true): Promise<void> => {
		current?.resolve(completed);
		current = undefined;
		await settle();
	};

	const output = new SpeechOutput({
		synthesizer: { synthesize },
		playback,
		logger,
		now: () => clock.now,
	});
	return { output, synthesize, hold, failing, playback, played, endPlaying, logger, clock };
}

describe("SpeechOutput", () => {
	it("足した文はすぐ合成を始め、release までは再生しない", async () => {
		const { output, synthesize, playback, played } = setup();
		const reply = output.begin();

		reply.add("一。");
		await settle();

		expect(synthesize).toHaveBeenCalledWith("一。");
		expect(playback.play).not.toHaveBeenCalled();
		expect(output.speaking).toBe(false);
		reply.release();
		await settle();
		expect(played()).toEqual(["一。"]);
		expect(reply.released).toBe(true);
	});

	it("合成は1文ずつ順に行い、前の文の合成が終わるまで次を始めない", async () => {
		const { output, synthesize, hold } = setup();
		const gate = hold("一。");
		const reply = output.begin();

		reply.add("一。");
		reply.add("二。");
		await settle();
		expect(synthesize.mock.calls).toEqual([["一。"]]);
		gate.resolve();
		await settle();

		expect(synthesize.mock.calls).toEqual([["一。"], ["二。"]]);
	});

	it("言った順に1文ずつ再生し、finish の後すべて再生し終えたら done を解決する", async () => {
		const { output, played, endPlaying } = setup();
		const reply = output.begin();
		reply.add("一。");
		reply.add("二。");
		reply.release();
		reply.finish();
		await settle();

		expect(played()).toEqual(["一。"]);
		expect(output.speaking).toBe(true);
		expect(reply.current()).toBe("一。");
		await endPlaying();
		expect(played()).toEqual(["一。", "二。"]);
		expect(reply.current()).toBe("二。");
		await endPlaying();

		await expect(reply.done).resolves.toEqual({ played: ["一。", "二。"], cut: null, dropped: [] });
		expect(output.speaking).toBe(false);
		expect(reply.current()).toBeUndefined();
	});

	it("release の後に足した文も続けて再生し、finish までは done を解決しない", async () => {
		const { output, played, endPlaying } = setup();
		const reply = output.begin();
		let done = false;
		void reply.done.then(() => {
			done = true;
		});
		reply.release();
		await settle();

		reply.add("一。");
		await settle();
		expect(played()).toEqual(["一。"]);
		await endPlaying();
		expect(done).toBe(false);
		reply.finish();
		await settle();

		expect(done).toBe(true);
		await expect(reply.done).resolves.toEqual({ played: ["一。"], cut: null, dropped: [] });
	});

	it("文がないまま release 前に finish したら、何も再生せず done を解決する", async () => {
		const { output, playback } = setup();
		const reply = output.begin();

		reply.finish();
		await expect(reply.done).resolves.toEqual({ played: [], cut: null, dropped: [] });
		reply.release();
		await settle();

		expect(playback.play).not.toHaveBeenCalled();
	});

	it("cancel で再生中の文を途中で止めた文、残りを再生しなかった文にし、再生を止める", async () => {
		const { output, playback, endPlaying } = setup();
		const reply = output.begin();
		reply.add("一。");
		reply.add("二。");
		reply.add("三。");
		reply.release();
		await settle();
		await endPlaying();

		const spoken = reply.cancel();

		const expected = { played: ["一。"], cut: "二。", dropped: ["三。"] };
		expect(spoken).toEqual(expected);
		expect(playback.stop).toHaveBeenCalledTimes(1);
		await expect(reply.done).resolves.toEqual(expected);
		await settle();
		expect(playback.play).toHaveBeenCalledTimes(2);
		expect(reply.cancel()).toEqual(expected);
	});

	it("release 前の cancel は再生を止めず、まだ合成していない文は合成しない", async () => {
		const { output, synthesize, hold, playback } = setup();
		const gate = hold("一。");
		const reply = output.begin();
		reply.add("一。");
		reply.add("二。");
		await settle();

		expect(reply.cancel()).toEqual({ played: [], cut: null, dropped: ["一。", "二。"] });
		reply.add("三。");
		reply.release();
		gate.resolve();
		await settle();

		expect(playback.stop).not.toHaveBeenCalled();
		expect(playback.play).not.toHaveBeenCalled();
		expect(synthesize.mock.calls).toEqual([["一。"]]);
		expect(reply.released).toBe(false);
	});

	it("合成に失敗した文はログに残して飛ばし、次の文を再生する", async () => {
		const { output, failing, played, endPlaying, logger } = setup();
		failing.add("二。");
		const reply = output.begin();
		reply.add("一。");
		reply.add("二。");
		reply.add("三。");
		reply.release();
		reply.finish();
		await settle();
		await endPlaying();
		await endPlaying();

		expect(played()).toEqual(["一。", "三。"]);
		await expect(reply.done).resolves.toEqual({ played: ["一。", "三。"], cut: null, dropped: [] });
		expect(logger.entries).toContainEqual(
			expect.objectContaining({
				level: "error",
				event: "voice.speech.synthesis_failed",
				details: expect.objectContaining({ chars: 2 }),
			}),
		);
	});

	it("再生が外から止められたら、その文を途中で止めた文にし、残りを再生せずに終える", async () => {
		const { output, played, endPlaying } = setup();
		const reply = output.begin();
		reply.add("一。");
		reply.add("二。");
		reply.release();
		await settle();

		await endPlaying(false);

		await expect(reply.done).resolves.toEqual({ played: [], cut: "一。", dropped: ["二。"] });
		expect(played()).toEqual(["一。"]);
	});

	it("再生が例外で終わったらログに残し、その文を記録に入れずに残りを捨てて終える", async () => {
		const { output, playback, logger } = setup();
		playback.play.mockImplementationOnce(() => {
			throw new Error("player broken");
		});
		const reply = output.begin();
		reply.add("一。");
		reply.add("二。");
		reply.release();
		await settle();

		await expect(reply.done).resolves.toEqual({ played: [], cut: null, dropped: ["二。"] });
		expect(reply.playing).toBe(false);
		expect(reply.current()).toBeUndefined();
		expect(output.speaking).toBe(false);
		expect(logger.entries).toContainEqual(
			expect.objectContaining({ level: "error", event: "voice.speech.playback_failed" }),
		);
	});

	it("新しい返事を始めると前の返事は止まり、新しい返事だけが話す", async () => {
		const { output, playback, played, endPlaying } = setup();
		const first = output.begin();
		first.add("前。");
		first.add("前の続き。");
		first.release();
		await settle();

		const second = output.begin();

		await expect(first.done).resolves.toEqual({
			played: [],
			cut: "前。",
			dropped: ["前の続き。"],
		});
		expect(playback.stop).toHaveBeenCalledTimes(1);
		expect(output.speaking).toBe(false);
		second.add("次。");
		second.release();
		second.finish();
		await settle();
		expect(output.speaking).toBe(true);
		await endPlaying();
		expect(played()).toEqual(["前。", "次。"]);
		await expect(second.done).resolves.toEqual({ played: ["次。"], cut: null, dropped: [] });
	});

	it("終わった返事を後から止めても、今の返事には影響しない", async () => {
		const { output, playback } = setup();
		const first = output.begin();
		first.finish();
		await first.done;
		const second = output.begin();
		second.add("次。");
		second.release();
		await settle();

		expect(first.cancel()).toEqual({ played: [], cut: null, dropped: [] });
		expect(playback.stop).not.toHaveBeenCalled();
		expect(output.speaking).toBe(true);
	});

	it("最初の文を合成し終えた時刻と再生し始めた時刻を残し、2文目以降では書き換えない", async () => {
		const { output, hold, clock, endPlaying } = setup();
		const gate = hold("一。");
		const reply = output.begin();
		reply.add("一。");
		reply.add("二。");
		await settle();
		expect(reply.timings).toEqual({ firstSynthesizedAt: undefined, firstPlayedAt: undefined });

		clock.now = 100;
		gate.resolve();
		await settle();
		clock.now = 250;
		reply.release();
		await settle();
		clock.now = 900;
		await endPlaying();

		expect(reply.timings).toEqual({ firstSynthesizedAt: 100, firstPlayedAt: 250 });
	});

	it("音量の変更は再生側へそのまま渡す", () => {
		const { output, playback } = setup();

		output.setVolume(0.3);

		expect(playback.setVolume).toHaveBeenCalledWith(0.3);
	});
});
