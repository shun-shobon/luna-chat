import { describe, expect, it } from "vitest";

import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { VoicePcm } from "../ports/speech-port";
import { SpeechQueue } from "./speech-queue";

const flush = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup() {
	const syntheses: Array<{ text: string; done: PromiseWithResolvers<VoicePcm> }> = [];
	const plays: Array<{ audio: string; done: PromiseWithResolvers<boolean> }> = [];
	let stops = 0;
	const logger = createRecordingLogger();
	const queue = new SpeechQueue({
		synthesizer: {
			synthesize: (text) => {
				const done = Promise.withResolvers<VoicePcm>();
				syntheses.push({ text, done });
				return done.promise;
			},
		},
		playback: {
			play: (audio) => {
				const done = Promise.withResolvers<boolean>();
				plays.push({ audio: audio.pcm.toString(), done });
				return done.promise;
			},
			stop: () => {
				stops += 1;
				plays.at(-1)?.done.resolve(false);
			},
		},
		logger,
	});
	return { queue, syntheses, plays, logger, stops: () => stops };
}

const pcm = (text: string): VoicePcm => ({ pcm: Buffer.from(text) });

describe("SpeechQueue", () => {
	it("言った順に再生し、次の文は前の文の再生中に合成しておく", async () => {
		const { queue, syntheses, plays } = setup();
		queue.say("一文目");
		queue.say("二文目");
		await flush();
		syntheses[0]?.done.resolve(pcm("A"));
		await flush();
		expect(plays.map((play) => play.audio)).toEqual(["A"]);
		expect(syntheses.map((synthesis) => synthesis.text)).toEqual(["一文目", "二文目"]);

		syntheses[1]?.done.resolve(pcm("B"));
		await flush();
		expect(plays).toHaveLength(1);
		plays[0]?.done.resolve(true);
		await flush();

		expect(plays.map((play) => play.audio)).toEqual(["A", "B"]);
		expect(queue.busy).toBe(true);
		plays[1]?.done.resolve(true);
		await flush();
		expect(queue.busy).toBe(false);
	});

	it("遮られたら再生を止め、話し終えた文・途中の文・捨てた文を返し、まだ合成していない文は合成しない", async () => {
		const { queue, syntheses, plays, stops } = setup();
		queue.say("一文目");
		queue.say("二文目");
		queue.say("三文目");
		queue.say("四文目");
		await flush();
		syntheses[0]?.done.resolve(pcm("A"));
		await flush();
		syntheses[1]?.done.resolve(pcm("B"));
		plays[0]?.done.resolve(true);
		await flush();
		expect(syntheses.map((synthesis) => synthesis.text)).toEqual(["一文目", "二文目", "三文目"]);

		expect(queue.interrupt()).toEqual({
			played: ["一文目"],
			cut: "二文目",
			dropped: ["三文目", "四文目"],
		});
		syntheses[2]?.done.resolve(pcm("C"));
		await flush();

		expect(stops()).toBe(1);
		expect(syntheses).toHaveLength(3);
		expect(plays.map((play) => play.audio)).toEqual(["A", "B"]);
		expect(queue.busy).toBe(false);
	});

	it("合成中の文は途中の文ではなく捨てた文として返す", async () => {
		const { queue } = setup();
		queue.say("一文目");
		await flush();

		expect(queue.interrupt()).toEqual({ played: [], cut: null, dropped: ["一文目"] });
	});

	it("話していなければ遮っても何も返さない", () => {
		const { queue, stops } = setup();

		expect(queue.interrupt()).toBeUndefined();
		expect(stops()).toBe(0);
	});

	it("話し終えた文は、人の発話を渡した時点で数え直す", async () => {
		const { queue, syntheses, plays } = setup();
		queue.say("前の返事");
		await flush();
		syntheses[0]?.done.resolve(pcm("A"));
		await flush();
		plays[0]?.done.resolve(true);
		await flush();
		queue.markTurn();
		queue.say("次の返事");
		await flush();

		expect(queue.interrupt()).toEqual({ played: [], cut: null, dropped: ["次の返事"] });
	});

	it("合成に失敗した文はログに残して飛ばし、次の文を話す", async () => {
		const { queue, syntheses, plays, logger } = setup();
		queue.say("一文目");
		queue.say("二文目");
		await flush();
		syntheses[0]?.done.reject(new Error("engine down"));
		await flush();
		syntheses[1]?.done.resolve(pcm("B"));
		await flush();

		expect(plays.map((play) => play.audio)).toEqual(["B"]);
		expect(logger.entries.map((entry) => entry.event)).toContain("voice.speech.synthesis_failed");
	});

	it("遮った後に言った文は、続けて話す", async () => {
		const { queue, syntheses, plays } = setup();
		queue.say("一文目");
		await flush();
		syntheses[0]?.done.resolve(pcm("A"));
		await flush();
		queue.interrupt();
		await flush();

		queue.say("言い直し");
		await flush();
		syntheses[1]?.done.resolve(pcm("C"));
		await flush();

		expect(plays.map((play) => play.audio)).toEqual(["A", "C"]);
	});
});
