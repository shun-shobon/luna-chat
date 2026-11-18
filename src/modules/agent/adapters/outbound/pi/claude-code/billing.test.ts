import { fauxAssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { describeUsageCreditsRejection } from "./billing";
import { closeClaudeProcesses, runClaudeRequest } from "./claude-cli";
import { normalizeError } from "./stream";
import { AUTH_STATUS_OK, createFakeClaude } from "./testing";
import type { FakeClaude } from "./testing";

function retryable(errorMessage: string): boolean {
	return isRetryableAssistantError(fauxAssistantMessage([], { stopReason: "error", errorMessage }));
}

const fakes: FakeClaude[] = [];

afterEach(async () => {
	await closeClaudeProcesses();
	await Promise.all(
		fakes.splice(0).map(async (fake) => {
			await fake.cleanup();
		}),
	);
});

describe("describeUsageCreditsRejection", () => {
	it.each([
		"Claude Code API error: API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
		"Incomplete Claude Code upstream response (status 400, upstream said: Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin to add more and keep going.)",
		"Incomplete Claude Code upstream response (status 400, upstream said: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.)",
	])("超過課金への振り替えを再試行しない billing のエラーに書き換える: %s", (upstream) => {
		const message = normalizeError(new Error(upstream));
		expect(message).toMatch(/^Claude Code billing:/u);
		expect(message.endsWith(upstream)).toBe(true);
		// 一時的に見える文言が付いていても再試行させない。
		expect(retryable(`${message} 429 overloaded`)).toBe(false);
	});

	it("関係のないエラーはそのまま", () => {
		expect(describeUsageCreditsRejection("Claude Code API error: overloaded")).toBeUndefined();
		expect(normalizeError(new Error("prompt is too long: 300000 tokens"))).toBe(
			"context_length_exceeded: prompt is too long: 300000 tokens",
		);
	});
});

describe("超過課金の検知", () => {
	it("Claude Code が超過課金で払ったと報告したら止める", async () => {
		const fake = await createFakeClaude(`import readline from "node:readline";
${AUTH_STATUS_OK}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1};
  const events = [
    {type: "message_start", message: {id: "m", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "ok"}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m", role: "assistant", content: [{type: "text", text: "ok"}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "rate_limit_event", rate_limit_info: {
    status: process.env.FAKE_STATUS, rateLimitType: "five_hour", isUsingOverage: process.env.FAKE_OVERAGE === "1",
    overageStatus: "allowed", overageDisabledReason: null
  }}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`);
		fakes.push(fake);
		const request = async (env: Record<string, string>) =>
			await runClaudeRequest({
				model: "claude-sonnet-5-5",
				cwd: fake.root,
				frames: [
					{ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
				],
				systemPrompt: "system",
				manifest: [],
				extraBody: { tools: [] },
				env: { ...fake.env, ...env },
				timeoutMs: 5000,
			});

		const plan = await request({ FAKE_STATUS: "allowed", FAKE_OVERAGE: "0" });
		expect(plan.rateLimit).toMatchObject({ status: "allowed", isUsingOverage: false });

		const charged = await request({ FAKE_STATUS: "allowed_warning", FAKE_OVERAGE: "1" }).catch(
			(error: unknown) => error,
		);
		expect(charged).toBeInstanceOf(Error);
		const message = charged instanceof Error ? charged.message : "";
		expect(message).toBe(
			"Claude Code billing: this request was charged to Claude usage credits instead of your plan limits " +
				"(rate limit status allowed_warning, five_hour). luna stopped so further requests are not charged. " +
				"To stay on plan limits only, turn off usage credits at claude.ai/settings/usage.",
		);
		expect(retryable(message)).toBe(false);
	}, 15_000);
});
