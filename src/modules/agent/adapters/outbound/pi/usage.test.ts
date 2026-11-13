import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatGptBackend } from "./chatgpt-backend";
import { fetchUsage } from "./usage";

const fetchMock = vi.fn<typeof fetch>();
const ACCESS_TOKEN = `header.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
).toString("base64")}.signature`;

async function createBackend(loggedIn: boolean, timeoutMs = 1000): Promise<ChatGptBackend> {
	const credentials = new InMemoryCredentialStore();
	if (loggedIn) {
		await credentials.modify("openai-codex", async () => ({
			type: "oauth",
			access: ACCESS_TOKEN,
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
			accountId: "account-1",
		}));
	}
	const models = createModels({ credentials });
	models.setProvider(openaiCodexProvider());
	return new ChatGptBackend({ models, timeoutMs });
}

function hangUntilAborted(
	_input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => {
			const reason: unknown = init.signal?.reason;
			reject(reason instanceof Error ? reason : new Error(String(reason)));
		});
	});
}

function window(usedPercent: number, seconds: number, resetAt: number) {
	return {
		used_percent: usedPercent,
		limit_window_seconds: seconds,
		reset_after_seconds: 60,
		reset_at: resetAt,
	};
}

describe("fetchUsage", () => {
	const signal = new AbortController().signal;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-14T00:00:00.000Z"));
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("本体と追加の使用枠をlimitId付きのスナップショットに変換する", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({
				plan_type: "pro",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: window(12.5, 18_000, 1_794_628_800),
					secondary_window: window(40, 604_799, 1_795_000_000),
				},
				credits: null,
				additional_rate_limits: [
					{
						limit_name: "Image generation",
						metered_feature: "image_gen",
						rate_limit: {
							primary_window: window(100, 86_400, 1_794_700_000),
							secondary_window: null,
						},
					},
					{ limit_name: "Other", metered_feature: "other", rate_limit: null },
				],
			}),
		);

		await expect(fetchUsage(await createBackend(true), signal)).resolves.toEqual({
			fetchedAt: "2026-11-14T00:00:00.000Z",
			planType: "pro",
			limits: [
				{
					limitId: "codex",
					primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: "2026-11-14T04:00:00.000Z" },
					secondary: {
						usedPercent: 40,
						windowMinutes: 10_080,
						resetsAt: "2026-11-18T11:06:40.000Z",
					},
				},
				{
					limitId: "image_gen",
					primary: { usedPercent: 100, windowMinutes: 1440, resetsAt: "2026-11-14T23:46:40.000Z" },
					secondary: null,
				},
				{ limitId: "other", primary: null, secondary: null },
			],
		});
		const input = fetchMock.mock.calls[0]?.[0];
		expect(input instanceof Request ? input.url : String(input)).toBe(
			"https://chatgpt.com/backend-api/wham/usage",
		);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
	});

	it("使用枠のない応答は枠なしとして返す", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ plan_type: "free" }));

		await expect(fetchUsage(await createBackend(true), signal)).resolves.toMatchObject({
			planType: "free",
			limits: [{ limitId: "codex", primary: null, secondary: null }],
		});
	});

	it("HTTPエラーをそのまま失敗にする", async () => {
		fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

		await expect(fetchUsage(await createBackend(true), signal)).rejects.toMatchObject({
			kind: "http",
			status: 401,
		});
	});

	it("応答がなければtimeoutで失敗する", async () => {
		fetchMock.mockImplementationOnce(hangUntilAborted);

		await expect(fetchUsage(await createBackend(true, 20), signal)).rejects.toMatchObject({
			kind: "timeout",
		});
	});

	it("plan_typeがない応答や長さ0の枠はinvalid_responseで失敗する", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ rate_limit: null })).mockResolvedValueOnce(
			Response.json({
				plan_type: "pro",
				rate_limit: { primary_window: window(1, 0, 1_794_628_800) },
			}),
		);
		const backend = await createBackend(true);

		await expect(fetchUsage(backend, signal)).rejects.toMatchObject({ kind: "invalid_response" });
		await expect(fetchUsage(backend, signal)).rejects.toMatchObject({ kind: "invalid_response" });
	});

	it("資格情報がなければauth_requiredで失敗する", async () => {
		await expect(fetchUsage(await createBackend(false), signal)).rejects.toMatchObject({
			kind: "auth_required",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
