import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PiDecisionModel } from "./pi-decision-model";

type Handler = () => Promise<Response> | Response;

function fetchWith(handler: Handler) {
	const bodies: unknown[] = [];
	const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		if (typeof init?.body !== "string") throw new TypeError("expected a JSON body");
		bodies.push(JSON.parse(init.body));
		return await handler();
	});
	return { fetch, bodies };
}

function answers(action: string, goal: string, probability: number): Response {
	return Response.json({
		model: "gpt-6-luna",
		answers: [
			{
				type: "choice",
				name: "action",
				choice: action,
				confidence: 0.9,
				probabilities: [{ value: action, probability: 0.9 }],
			},
			{
				type: "choice",
				name: "goal",
				choice: goal,
				confidence: probability,
				probabilities: [{ value: goal, probability }],
			},
		],
		usage: { input_tokens: 200, output_tokens: 0, total_tokens: 200 },
	});
}

async function model(fetch: typeof globalThis.fetch) {
	return await PiDecisionModel.create({
		provider: "openai",
		model: "gpt-6-luna",
		timeoutMs: 2000,
		fetch,
	});
}

beforeEach(() => {
	vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("PiDecisionModel", () => {
	it("候補を a0, a1… の選択肢、目標の状態を3択にして1回で尋ね、選ばれた番号と確率を返す", async () => {
		const { fetch, bodies } = fetchWith(() => answers("a1", "in_progress", 0.85));

		const decision = await (
			await model(fetch)
		).decide(
			{
				state: { goal: { objective: "Collect logs" } },
				candidates: ["Explore north", "Mine the oak_log"],
			},
			new AbortController().signal,
		);

		expect(decision).toEqual({ choice: 1, goal: { status: "in_progress", probability: 0.85 } });
		expect(fetch).toHaveBeenCalledOnce();
		expect(bodies[0]).toMatchObject({
			model: "gpt-6-luna",
			input: JSON.stringify({ goal: { objective: "Collect logs" } }),
			questions: [
				{
					type: "choice",
					name: "action",
					choices: [
						{ value: "a0", description: "Explore north" },
						{ value: "a1", description: "Mine the oak_log" },
					],
				},
				{ type: "choice", name: "goal" },
			],
		});
	});

	it("候補にない選択や、知らない目標の状態は例外にする", async () => {
		const unknownChoice = await model(fetchWith(() => answers("a9", "done", 0.9)).fetch);
		const unknownStatus = await model(fetchWith(() => answers("a0", "maybe", 0.9)).fetch);
		const input = { state: {}, candidates: ["Wait for 2 seconds"] };

		await expect(unknownChoice.decide(input, new AbortController().signal)).rejects.toThrow(
			"decision chose an unknown candidate: a9",
		);
		await expect(unknownStatus.decide(input, new AbortController().signal)).rejects.toBeInstanceOf(
			z.ZodError,
		);
	});

	it("HTTP の失敗は再試行せずに例外にする", async () => {
		const { fetch } = fetchWith(() => new Response("overloaded", { status: 503 }));

		await expect(
			(await model(fetch)).decide(
				{ state: {}, candidates: ["Wait"] },
				new AbortController().signal,
			),
		).rejects.toThrow(/503/u);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("鍵がなければ作る時に断る", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");

		await expect(model(fetchWith(() => answers("a0", "done", 1)).fetch)).rejects.toThrow(
			"No API key for decision model provider: openai",
		);
	});
});
