import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, describe, expect, it } from "vitest";

import { closeClaudeProcesses } from "./claude-cli";
import { claudeCodeProvider } from "./provider";
import { AUTH_STATUS_OK, createFakeClaude } from "./testing";
import type { FakeClaude } from "./testing";

const fakes: FakeClaude[] = [];
const CONFIG_DIR = "/luna-home/claude-code";
const originalPath = process.env["PATH"];

afterEach(async () => {
	process.env["PATH"] = originalPath;
	await closeClaudeProcesses();
	await Promise.all(
		fakes.splice(0).map(async (fake) => {
			await fake.cleanup();
		}),
	);
});

async function check(body: string) {
	const fake = await createFakeClaude(body);
	fakes.push(fake);
	process.env["PATH"] = fake.env.PATH;
	return await claudeCodeProvider({ configDir: CONFIG_DIR }).auth.apiKey?.check?.({
		ctx: {
			env: () => Promise.resolve(undefined),
			fileExists: () => Promise.resolve(false),
		},
		signal: new AbortController().signal,
	});
}

describe("claudeCodeProvider", () => {
	it("Claude Code のモデルを claude-code として載せる", () => {
		const models = createModels();
		models.setProvider(claudeCodeProvider({ configDir: CONFIG_DIR }));
		expect(models.getModel("claude-code", "claude-opus-5-5")?.api).toBe("claude-code-stream-json");
	});

	it("サブスクでログイン済みなら設定済みと報告する", async () => {
		await expect(check(AUTH_STATUS_OK)).resolves.toEqual({
			type: "oauth",
			source: "Claude Code max",
		});
	});

	it("ログイン状態は専用の設定ディレクトリで確かめる", async () => {
		const original = process.env["CLAUDE_CONFIG_DIR"];
		process.env["CLAUDE_CONFIG_DIR"] = "/home/luna/.claude";
		try {
			await expect(
				check(
					`if (process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(CONFIG_DIR)}) { console.log(JSON.stringify({loggedIn: false})); process.exit(1); }\n${AUTH_STATUS_OK}`,
				),
			).resolves.toEqual({ type: "oauth", source: "Claude Code max" });
		} finally {
			if (original === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
			else process.env["CLAUDE_CONFIG_DIR"] = original;
		}
	});

	it("リクエストの Claude Code も専用の設定ディレクトリで起動する", async () => {
		const fake = await createFakeClaude(`import readline from "node:readline";
${AUTH_STATUS_OK}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  if (JSON.parse(line).type !== "user") continue;
  const usage = {input_tokens: 1, output_tokens: 1};
  const text = process.env.CLAUDE_CONFIG_DIR;
  for (const event of [
    {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"},
  ]) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m", role: "assistant", content: [{type: "text", text}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`);
		fakes.push(fake);
		process.env["PATH"] = fake.env.PATH;
		const models = createModels();
		models.setProvider(claudeCodeProvider({ configDir: CONFIG_DIR }));
		const model = models.getModel("claude-code", "claude-haiku-5-5");
		if (model === undefined) throw new Error("missing claude-haiku-5-5");

		const message = await models
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ timeoutMs: 5000, cacheRetention: "none" },
			)
			.result();

		expect(message.content).toEqual([{ type: "text", text: CONFIG_DIR }]);
	}, 10_000);

	it("ログインしていなければ未設定と報告する", async () => {
		await expect(
			check(`console.log(JSON.stringify({loggedIn: false})); process.exit(1);`),
		).resolves.toBeUndefined();
	});

	it("鍵は形だけの値で解決する", async () => {
		await expect(
			claudeCodeProvider({ configDir: CONFIG_DIR }).auth.apiKey?.resolve({
				ctx: {
					env: () => Promise.resolve(undefined),
					fileExists: () => Promise.resolve(false),
				},
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ auth: { apiKey: "external-process" }, source: "Claude Code CLI" });
	});
});
