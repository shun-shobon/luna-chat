import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpeechCppSynthesizer } from "./speech-cpp-synthesizer";

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
		return Buffer.concat([header, body]);
	};
	const body = Buffer.concat([
		Buffer.from("WAVE", "ascii"),
		chunk("fmt ", fmt),
		chunk("data", input.data),
	]);
	const riff = Buffer.alloc(8);
	riff.write("RIFF", 0, "ascii");
	riff.writeUInt32LE(body.length, 4);
	return Buffer.concat([riff, body]);
}

function samples(values: number[]): Buffer {
	const buffer = Buffer.alloc(values.length * 2);
	values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
	return buffer;
}

function synthesizer(timeoutMs = 5000): SpeechCppSynthesizer {
	return new SpeechCppSynthesizer({
		baseUrl: new URL("http://192.168.0.150:8090/"),
		voice: "luna",
		speed: 1.1,
		timeoutMs,
	});
}

describe("SpeechCppSynthesizer", () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("声の名前と話速を指定して合成し、モノラルのPCMを左右に複製したステレオで返す", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(wav({ channels: 1, sampleRate: 48_000, bits: 16, data: samples([1, -2, 300]) })),
		);

		await expect(synthesizer().synthesize("こんにちは")).resolves.toEqual({
			pcm: samples([1, 1, -2, -2, 300, 300]),
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toEqual(new URL("http://192.168.0.150:8090/v1/audio/speech"));
		expect(init?.method).toBe("POST");
		if (typeof init?.body !== "string") throw new Error("expected a JSON body");
		expect(JSON.parse(init.body)).toEqual({
			input: "こんにちは",
			voice: "luna",
			speed: 1.1,
			response_format: "wav",
		});
	});

	it("ステレオで返ってきたPCMはそのまま返す", async () => {
		const pcm = samples([5, 6]);
		fetchMock.mockResolvedValueOnce(
			new Response(wav({ channels: 2, sampleRate: 48_000, bits: 16, data: pcm })),
		);

		await expect(synthesizer().synthesize("あ")).resolves.toEqual({ pcm });
	});

	it("合成が失敗したら、状態とサーバーの返した本文を含めて失敗する", async () => {
		fetchMock.mockResolvedValueOnce(new Response("unknown voice", { status: 400 }));

		await expect(synthesizer().synthesize("あ")).rejects.toThrow(
			"speech.cpp synthesis failed: 400 unknown voice",
		);
	});

	it("48kHz・16bit以外のWAVとWAVでない応答は失敗する", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(wav({ channels: 1, sampleRate: 24_000, bits: 16, data: samples([1]) })),
		);
		await expect(synthesizer().synthesize("あ")).rejects.toThrow("unexpected WAV format");

		fetchMock.mockResolvedValueOnce(new Response("not audio"));
		await expect(synthesizer().synthesize("あ")).rejects.toThrow("not a WAV file");
	});

	it("時間内に返らなければ打ち切って失敗する", async () => {
		fetchMock.mockImplementationOnce(
			async (_url, init) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
						once: true,
					});
				}),
		);

		await expect(synthesizer(20).synthesize("あ")).rejects.toThrow("timed out");
	});
});
