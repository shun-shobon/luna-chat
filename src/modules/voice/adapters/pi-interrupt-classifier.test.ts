import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiInterruptClassifier } from "./pi-interrupt-classifier";

const QUESTION = { heard: "ちょっと待って", lunaSaying: "明日は晴れるみたいだよ。" };

type Handler = (body: unknown, signal: AbortSignal | undefined) => Promise<Response> | Response;

function fetchWith(handler: Handler) {
	const requests: { url: string; headers: Headers; body: unknown }[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		if (typeof init?.body !== "string") throw new Error("expected a JSON body");
		const body: unknown = JSON.parse(init.body);
		const url = input instanceof Request ? input.url : input.toString();
		requests.push({ url, headers: new Headers(init.headers), body });
		return await handler(body, init.signal ?? undefined);
	});
	return { fetch, requests };
}

function decision(choice: unknown): Response {
	return Response.json({
		model: "gpt-6-luna",
		answers: [
			{
				type: "choice",
				name: "turn",
				choice,
				confidence: 0.9,
				probabilities: [{ value: choice, probability: 0.9 }],
			},
		],
		usage: { input_tokens: 80, output_tokens: 0, total_tokens: 80 },
	});
}

async function classifier(fetch: typeof globalThis.fetch, timeoutMs = 2000) {
	return await PiInterruptClassifier.create({
		provider: "openai",
		model: "gpt-6-luna",
		timeoutMs,
		fetch,
	});
}

beforeEach(() => {
	vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("PiInterruptClassifier", () => {
	it("聞こえた声と読み上げ中の文を Decisions API の3択で尋ね、選ばれた判定を返す", async () => {
		const { fetch, requests } = fetchWith(() => decision("interruption"));

		const verdict = await (
			await classifier(fetch)
		).classify(QUESTION, new AbortController().signal);

		expect(verdict).toBe("interruption");
		expect(requests[0]?.url).toBe("https://api.openai.com/v1/decisions");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-test");
		expect(requests[0]?.body).toMatchObject({
			model: "gpt-6-luna",
			input: JSON.stringify({ luna_is_saying: QUESTION.lunaSaying, heard: QUESTION.heard }),
			questions: [
				{
					type: "choice",
					name: "turn",
					choices: [{ value: "interruption" }, { value: "backchannel" }, { value: "not_to_luna" }],
				},
			],
		});
	});

	it("HTTP の失敗は再試行せずに例外にする", async () => {
		const { fetch } = fetchWith(() => new Response("overloaded", { status: 503 }));

		await expect(
			(await classifier(fetch)).classify(QUESTION, new AbortController().signal),
		).rejects.toThrow(/503/u);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("答えのない応答や知らない選択肢は例外にする", async () => {
		const empty = fetchWith(() => Response.json({ model: "gpt-6-luna", answers: [] }));
		await expect(
			(await classifier(empty.fetch)).classify(QUESTION, new AbortController().signal),
		).rejects.toThrow(/did not return an answer/u);

		const unknown = fetchWith(() => decision("maybe"));
		await expect(
			(await classifier(unknown.fetch)).classify(QUESTION, new AbortController().signal),
		).rejects.toThrow(/invalid_value/u);
	});

	it("時間内に返らなければ例外にする", async () => {
		const { fetch } = fetchWith(
			async (_body, signal) =>
				await new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);

		await expect(
			(await classifier(fetch, 50)).classify(QUESTION, new AbortController().signal),
		).rejects.toThrow(/timed out/u);
	});

	it("カタログにない判定モデルと鍵のない提供元は作る時に断る", async () => {
		const { fetch } = fetchWith(() => decision("backchannel"));
		await expect(
			PiInterruptClassifier.create({ provider: "openai", model: "missing", timeoutMs: 1, fetch }),
		).rejects.toThrow("Unknown classifier model: openai/missing");

		vi.stubEnv("OPENAI_API_KEY", undefined);
		await expect(classifier(fetch)).rejects.toThrow("No API key for classifier provider: openai");
	});
});
