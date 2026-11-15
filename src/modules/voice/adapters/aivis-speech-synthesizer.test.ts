import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AivisSpeechSynthesizer } from "./aivis-speech-synthesizer";

const fetchMock = vi.fn<typeof fetch>();

function wav(input: { channels: number; sampleRate: number; bits: number; data: Buffer }): Buffer {
	const fmt = Buffer.alloc(16);
	fmt.writeUInt16LE(1, 0);
	fmt.writeUInt16LE(input.channels, 2);
	fmt.writeUInt32LE(input.sampleRate, 4);
	fmt.writeUInt16LE(input.bits, 14);
	const chunk = (id: string, body: Buffer) => {
		const header = Buffer.alloc(8);
		header.write(id, 0, "ascii");
		header.writeUInt32LE(body.length, 4);
		return Buffer.concat([header, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
	};
	const body = Buffer.concat([
		Buffer.from("WAVE", "ascii"),
		chunk("fmt ", fmt),
		chunk("LIST", Buffer.from("odd", "ascii")),
		chunk("data", input.data),
	]);
	const riff = Buffer.alloc(8);
	riff.write("RIFF", 0, "ascii");
	riff.writeUInt32LE(body.length, 4);
	return Buffer.concat([riff, body]);
}

const synthesizer = new AivisSpeechSynthesizer(new URL("http://127.0.0.1:10101/"), 888753760, 1.25);

describe("AivisSpeechSynthesizer", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("問い合わせ結果に話速と48kHzステレオを指定して合成に送り、WAVのPCM部分を返す", async () => {
		const pcm = Buffer.from([1, 2, 3, 4]);
		fetchMock
			.mockResolvedValueOnce(
				Response.json({ accent_phrases: [], speedScale: 1, kana: "コンニチワ" }),
			)
			.mockResolvedValueOnce(
				new Response(wav({ channels: 2, sampleRate: 48_000, bits: 16, data: pcm })),
			);

		await expect(synthesizer.synthesize("こんにちは")).resolves.toEqual({ pcm });

		const [queryUrl] = fetchMock.mock.calls[0] ?? [];
		expect(queryUrl).toEqual(
			new URL(
				"http://127.0.0.1:10101/audio_query?text=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF&speaker=888753760",
			),
		);
		const [synthesisUrl, init] = fetchMock.mock.calls[1] ?? [];
		expect(synthesisUrl).toEqual(new URL("http://127.0.0.1:10101/synthesis?speaker=888753760"));
		expect(typeof init?.body === "string" ? JSON.parse(init.body) : undefined).toEqual({
			accent_phrases: [],
			speedScale: 1.25,
			kana: "コンニチワ",
			outputSamplingRate: 48_000,
			outputStereo: true,
		});
	});

	it("問い合わせが失敗したら、状態とエンジンの返した本文を含めて失敗する", async () => {
		fetchMock.mockResolvedValueOnce(new Response("speaker not found", { status: 422 }));

		await expect(synthesizer.synthesize("あ")).rejects.toThrow(
			"audio_query failed: 422 speaker not found",
		);
	});

	it("問い合わせの応答がJSONのオブジェクトでなければ失敗する", async () => {
		fetchMock.mockResolvedValueOnce(Response.json(["not", "an", "object"]));

		await expect(synthesizer.synthesize("あ")).rejects.toThrow("expected object");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("合成が失敗したら、状態を含めて失敗する", async () => {
		fetchMock
			.mockResolvedValueOnce(Response.json({}))
			.mockResolvedValueOnce(new Response("boom", { status: 500 }));

		await expect(synthesizer.synthesize("あ")).rejects.toThrow("synthesis failed: 500 boom");
	});

	it("48kHzステレオ16bit以外のWAVは失敗する", async () => {
		fetchMock
			.mockResolvedValueOnce(Response.json({}))
			.mockResolvedValueOnce(
				new Response(wav({ channels: 1, sampleRate: 24_000, bits: 16, data: Buffer.alloc(4) })),
			);

		await expect(synthesizer.synthesize("あ")).rejects.toThrow("unexpected WAV format");
	});

	it("WAVでない応答は失敗する", async () => {
		fetchMock
			.mockResolvedValueOnce(Response.json({}))
			.mockResolvedValueOnce(new Response("<html>"));

		await expect(synthesizer.synthesize("あ")).rejects.toThrow("not a WAV file");
	});
});
