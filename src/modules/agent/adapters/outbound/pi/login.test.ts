import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loginWithDeviceCode } from "./login";

const fetchMock = vi.fn<typeof fetch>();
const ACCESS_TOKEN = `header.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
).toString("base64")}.signature`;

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

describe("loginWithDeviceCode", () => {
	let credentials: InMemoryCredentialStore;

	function createTestModels() {
		const models = createModels({ credentials });
		models.setProvider(openaiCodexProvider());
		return models;
	}

	beforeEach(() => {
		credentials = new InMemoryCredentialStore();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("デバイスコードとURLを表示し、取得した資格情報を保存する", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		fetchMock
			.mockResolvedValueOnce(
				Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "1" }),
			)
			.mockResolvedValueOnce(
				Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" }),
			)
			.mockResolvedValueOnce(
				Response.json({ access_token: ACCESS_TOKEN, refresh_token: "refresh-1", expires_in: 3600 }),
			);

		await loginWithDeviceCode(createTestModels(), new AbortController().signal);

		expect(stdout).toHaveBeenCalledWith(
			"Open https://auth.openai.com/codex/device and enter the code: ABCD-EFGH\n",
		);
		expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
			"https://auth.openai.com/api/accounts/deviceauth/usercode",
			"https://auth.openai.com/api/accounts/deviceauth/token",
			"https://auth.openai.com/oauth/token",
		]);
		await expect(credentials.read("openai-codex")).resolves.toMatchObject({
			type: "oauth",
			access: ACCESS_TOKEN,
			refresh: "refresh-1",
			accountId: "account-1",
		});
	});

	it("デバイスコードを取得できなければ失敗し、何も保存しない", async () => {
		fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));

		await expect(
			loginWithDeviceCode(createTestModels(), new AbortController().signal),
		).rejects.toThrow("503");
		await expect(credentials.read("openai-codex")).resolves.toBeUndefined();
	});

	it("中断されたら失敗し、何も保存しない", async () => {
		const controller = new AbortController();
		fetchMock.mockImplementationOnce((input, init) => {
			const pending = hangUntilAborted(input, init);
			controller.abort(new Error("stopped"));
			return pending;
		});

		await expect(loginWithDeviceCode(createTestModels(), controller.signal)).rejects.toThrow(
			"stopped",
		);
		await expect(credentials.read("openai-codex")).resolves.toBeUndefined();
	});
});
