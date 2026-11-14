import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { ChatGptBackend } from "../modules/agent/adapters/outbound/pi/chatgpt-backend";
import { blindResults, parseReplayVariants, runReplay } from "./replay";
import type { ReplayResult } from "./replay";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (path) => await rm(path, { recursive: true, force: true })),
	);
});

describe("parseReplayVariants", () => {
	it("名前付きの指示の組を受け取り、ディレクトリ側の = は残す", () => {
		expect(parseReplayVariants(["current=/w", "proposed=/p=1"])).toEqual([
			{ name: "current", dir: "/w" },
			{ name: "proposed", dir: "/p=1" },
		]);
	});

	it.each([
		[[], "At least one variant"],
		[["=/w"], "<name>=<dir>"],
		[["a="], "<name>=<dir>"],
		[["a"], "<name>=<dir>"],
		[["a=/w", "a=/p"], "unique"],
	])("不正な引数 %j を拒否する", (values, message) => {
		expect(() => parseReplayVariants(values)).toThrow(message);
	});
});

describe("blindResults", () => {
	it("場面ごとに候補を並べ替えて A, B と名付け、対応を key に残す", () => {
		const results: ReplayResult[] = [
			{
				scene: "s1",
				variant: "current",
				status: "completed",
				calls: [{ tool: "x", arguments: 1 }],
			},
			{ scene: "s1", variant: "proposed", status: "completed", calls: [] },
		];
		const orders = [0.9, 0.1];

		const blind = blindResults(results, () => orders.shift() ?? 0);

		expect(blind).toEqual({
			candidates: [{ scene: "s1", candidates: { A: [], B: [{ tool: "x", arguments: 1 }] } }],
			key: { s1: { A: "proposed", B: "current" } },
		});
	});
});

describe("runReplay", () => {
	it("場面を指示の組ごとに再生し、外へ作用せずにツール呼び出しを記録する", async () => {
		const { faux, models, transcriptDir } = await setup();
		const prompts: string[] = [];
		const capture =
			(
				response: Parameters<typeof fauxAssistantMessage>[0],
				options?: Parameters<typeof fauxAssistantMessage>[1],
			): FauxResponseStep =>
			(context) => {
				const system = context.messages.find((message) => message.role === "system");
				prompts.push(typeof system?.content === "string" ? system.content : "");
				return fauxAssistantMessage(response, options);
			};
		faux.setResponses([
			capture(
				[
					fauxToolCall("exec_command", { cmd: "rm -rf /" }),
					fauxToolCall("send_message", {
						target: { kind: "channel", channelId: "200" },
						content: "やってみるね",
					}),
				],
				{ stopReason: "toolUse" },
			),
			capture([]),
			capture([]),
		]);

		const results = await runReplay({
			backend: new ChatGptBackend({ models, timeoutMs: 1_000 }),
			cwd: transcriptDir,
			model: { provider: "faux", model: "faux-1", thinking: "off" },
			models,
			requestTimeoutMs: 10_000,
			scenes: [{ id: "s1", inputs: [{ kind: "discord_message", text: "{}" }] }],
			scratchRoot: join(transcriptDir, "scratch"),
			transcriptDir,
			variants: [
				{ name: "current", systemPrompt: "OLD" },
				{ name: "proposed", systemPrompt: "NEW" },
			],
		});

		expect(prompts).toEqual([
			expect.stringMatching(/^OLD\n\n# Scratch directory\n/u),
			expect.stringMatching(/^OLD\n\n# Scratch directory\n/u),
			expect.stringMatching(/^NEW\n\n# Scratch directory\n/u),
		]);
		expect(results).toEqual([
			{
				scene: "s1",
				variant: "current",
				status: "completed",
				calls: [
					{ tool: "exec_command", arguments: { cmd: "rm -rf /" } },
					{
						tool: "send_message",
						arguments: {
							kind: "send_message",
							target: { kind: "channel", channelId: "200" },
							content: "やってみるね",
						},
					},
				],
			},
			{ scene: "s1", variant: "proposed", status: "completed", calls: [] },
		]);
	});

	it("ツール呼び出しが上限に達したら打ち切る", async () => {
		const { faux, models, transcriptDir } = await setup();
		faux.setResponses(
			Array.from({ length: 20 }, () =>
				fauxAssistantMessage([fauxToolCall("edit", { path: "a" })], { stopReason: "toolUse" }),
			),
		);

		const [result] = await runReplay({
			backend: new ChatGptBackend({ models, timeoutMs: 1_000 }),
			cwd: transcriptDir,
			model: { provider: "faux", model: "faux-1", thinking: "off" },
			models,
			requestTimeoutMs: 10_000,
			scenes: [{ id: "s1", inputs: [{ kind: "discord_message", text: "{}" }] }],
			scratchRoot: join(transcriptDir, "scratch"),
			transcriptDir,
			variants: [{ name: "current", systemPrompt: "OLD" }],
		});

		expect(result?.status).toBe("aborted");
		expect(result?.calls).toHaveLength(12);
	});
});

async function setup() {
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux One" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const transcriptDir = await mkdtemp(join(tmpdir(), "luna-replay-test-"));
	temporaryDirectories.push(transcriptDir);
	return { faux, models, transcriptDir };
}
