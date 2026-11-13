import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ChatGptBackend, ChatGptBackendError } from "./chatgpt-backend";

const fetchMock = vi.fn<typeof fetch>();
const schema = z.strictObject({ ok: z.boolean() });

function fakeAccessToken(claims: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64")}.signature`;
}

function accountToken(accountId: string): string {
	return fakeAccessToken({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
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

function requestUrl(index: number): string {
	const input = fetchMock.mock.calls[index]?.[0];
	return input instanceof Request ? input.url : String(input);
}

describe("ChatGptBackend", () => {
	let credentials: InMemoryCredentialStore;

	function createBackend(timeoutMs = 1000): ChatGptBackend {
		const models = createModels({ credentials });
		models.setProvider(openaiCodexProvider());
		return new ChatGptBackend({ models, timeoutMs });
	}

	async function storeToken(access: string, expires = Date.now() + 3_600_000): Promise<void> {
		await credentials.modify("openai-codex", async () => ({
			type: "oauth",
			access,
			refresh: "refresh-1",
			expires,
			accountId: "account-1",
		}));
	}

	function get(backend: ChatGptBackend, signal = new AbortController().signal) {
		return backend.request({ method: "GET", path: "wham/usage", schema, signal });
	}

	beforeEach(() => {
		credentials = new InMemoryCredentialStore();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("保存済みの資格情報で認証ヘッダを付けて呼ぶ", async () => {
		const access = accountToken("account-1");
		await storeToken(access);
		fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));

		await expect(
			createBackend().request({
				method: "POST",
				path: "codex/alpha/search",
				body: { q: "x" },
				schema,
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ ok: true });

		const init = fetchMock.mock.calls[0]?.[1];
		expect(requestUrl(0)).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe('{"q":"x"}');
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${access}`);
		expect(headers.get("chatgpt-account-id")).toBe("account-1");
		expect(headers.get("originator")).toBe("pi");
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("期限が近いトークンはpi-aiで更新し、更新後のトークンを保存して使う", async () => {
		await storeToken(accountToken("account-1"), Date.now() + 1000);
		const refreshed = accountToken("account-2");
		fetchMock
			.mockResolvedValueOnce(
				Response.json({ access_token: refreshed, refresh_token: "refresh-2", expires_in: 3600 }),
			)
			.mockResolvedValueOnce(Response.json({ ok: true }));

		await expect(get(createBackend())).resolves.toEqual({ ok: true });

		expect(requestUrl(0)).toBe("https://auth.openai.com/oauth/token");
		const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${refreshed}`);
		expect(headers.get("chatgpt-account-id")).toBe("account-2");
		await expect(credentials.read("openai-codex")).resolves.toMatchObject({
			access: refreshed,
			refresh: "refresh-2",
			accountId: "account-2",
		});
	});

	it("資格情報がなければauth_requiredで失敗し、通信しない", async () => {
		await expect(get(createBackend())).rejects.toMatchObject({
			name: "ChatGptBackendError",
			kind: "auth_required",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("トークンの更新に失敗したらauth_requiredで失敗する", async () => {
		await storeToken(accountToken("account-1"), Date.now() - 1);
		fetchMock.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));

		await expect(get(createBackend())).rejects.toMatchObject({ kind: "auth_required" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("アカウントIDを含まないトークンはauth_requiredで失敗する", async () => {
		await storeToken(fakeAccessToken({ sub: "user" }));

		await expect(get(createBackend())).rejects.toMatchObject({ kind: "auth_required" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("HTTPエラーをステータス付きで返す", async () => {
		await storeToken(accountToken("account-1"));
		fetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429 }));

		const error = await get(createBackend()).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ChatGptBackendError);
		expect(error).toMatchObject({ kind: "http", status: 429 });
		expect(String(error)).toContain("slow down");
	});

	it("応答がなければtimeoutで失敗する", async () => {
		await storeToken(accountToken("account-1"));
		fetchMock.mockImplementationOnce(hangUntilAborted);

		await expect(get(createBackend(20))).rejects.toMatchObject({ kind: "timeout" });
	});

	it("呼び出し元の中断はタイムアウトと区別してそのまま返す", async () => {
		await storeToken(accountToken("account-1"));
		const controller = new AbortController();
		fetchMock.mockImplementationOnce((input, init) => {
			const pending = hangUntilAborted(input, init);
			controller.abort(new Error("stopped"));
			return pending;
		});

		await expect(get(createBackend(), controller.signal)).rejects.toThrow("stopped");
	});

	it("通信できなければnetworkで失敗する", async () => {
		await storeToken(accountToken("account-1"));
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

		await expect(get(createBackend())).rejects.toMatchObject({ kind: "network" });
	});

	it("JSONでない応答や形の違う応答はinvalid_responseで失敗する", async () => {
		await storeToken(accountToken("account-1"));
		fetchMock
			.mockResolvedValueOnce(new Response("<html>"))
			.mockResolvedValueOnce(Response.json({ ok: "yes" }));
		const backend = createBackend();

		await expect(get(backend)).rejects.toMatchObject({ kind: "invalid_response" });
		await expect(get(backend)).rejects.toMatchObject({ kind: "invalid_response" });
	});
});
