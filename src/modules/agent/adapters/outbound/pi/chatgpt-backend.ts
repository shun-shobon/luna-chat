import { ModelsError } from "@earendil-works/pi-ai";
import type { AuthResult, Models } from "@earendil-works/pi-ai";
import { z } from "zod";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
// pi-ai の openai-codex プロバイダが Codex 本体へ送るものと同じ値。
const ORIGINATOR = "pi";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_ERROR_BODY_LENGTH = 1024;

const accessTokenPayloadSchema = z.looseObject({
	[JWT_AUTH_CLAIM]: z.looseObject({ chatgpt_account_id: z.string().min(1) }),
});

export type ChatGptBackendErrorKind =
	| "auth_required"
	| "http"
	| "timeout"
	| "network"
	| "invalid_response";

export class ChatGptBackendError extends Error {
	constructor(
		readonly kind: ChatGptBackendErrorKind,
		message: string,
		readonly status: number | null,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ChatGptBackendError";
	}
}

export type ChatGptBackendRequest<T> = Readonly<{
	method: "GET" | "POST";
	// プロバイダの baseUrl（https://chatgpt.com/backend-api）からの相対パス。
	path: string;
	// 自前で組み立てた送信ペイロードなので、JSONに直せることは呼び出し側が保証する。
	body?: Readonly<Record<string, unknown>>;
	schema: z.ZodType<T>;
	signal: AbortSignal;
}>;

export type ChatGptBackendOptions = Readonly<{
	models: Models;
	timeoutMs: number;
}>;

// pi-ai が保存・更新する openai-codex の資格情報で chatgpt.com/backend-api を呼ぶ。
export class ChatGptBackend {
	constructor(private readonly options: ChatGptBackendOptions) {}

	async request<T>(request: ChatGptBackendRequest<T>): Promise<T> {
		const timeout = AbortSignal.timeout(this.options.timeoutMs);
		const signal = AbortSignal.any([request.signal, timeout]);
		try {
			return await this.send(request, signal);
		} catch (error) {
			request.signal.throwIfAborted();
			if (timeout.aborted) {
				throw new ChatGptBackendError(
					"timeout",
					`ChatGPT backend request timed out after ${this.options.timeoutMs}ms: ${request.path}`,
					null,
					{ cause: error },
				);
			}
			throw error;
		}
	}

	private async send<T>(request: ChatGptBackendRequest<T>, signal: AbortSignal): Promise<T> {
		const baseUrl = this.options.models.getProvider(OPENAI_CODEX_PROVIDER_ID)?.baseUrl;
		if (baseUrl === undefined) {
			throw new Error(`Provider is not registered: ${OPENAI_CODEX_PROVIDER_ID}`);
		}
		const accessToken = await this.accessToken(signal);
		const headers = new Headers({
			Authorization: `Bearer ${accessToken}`,
			"chatgpt-account-id": accountIdFromAccessToken(accessToken),
			originator: ORIGINATOR,
			accept: "application/json",
		});
		if (request.body !== undefined) headers.set("content-type", "application/json");

		let response: Response;
		try {
			response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/${request.path}`, {
				method: request.method,
				headers,
				...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
				signal,
			});
		} catch (error) {
			signal.throwIfAborted();
			throw new ChatGptBackendError(
				"network",
				`ChatGPT backend request failed: ${request.path}`,
				null,
				{
					cause: error,
				},
			);
		}

		const text = await response.text();
		if (!response.ok) {
			throw new ChatGptBackendError(
				"http",
				`ChatGPT backend returned ${response.status} for ${request.path}: ${truncate(text)}`,
				response.status,
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw new ChatGptBackendError(
				"invalid_response",
				`ChatGPT backend returned non-JSON for ${request.path}: ${truncate(text)}`,
				response.status,
				{ cause: error },
			);
		}
		const parsed = request.schema.safeParse(value);
		if (!parsed.success) {
			throw new ChatGptBackendError(
				"invalid_response",
				`ChatGPT backend returned an unexpected response for ${request.path}: ${z.prettifyError(parsed.error)}`,
				response.status,
				{ cause: parsed.error },
			);
		}
		return parsed.data;
	}

	private async accessToken(signal: AbortSignal): Promise<string> {
		let auth: AuthResult | undefined;
		try {
			// 期限が近ければ pi-ai が資格情報ストアのロック内で更新し、保存してから返す。
			auth = await this.options.models.getAuth(OPENAI_CODEX_PROVIDER_ID, { signal });
		} catch (error) {
			if (error instanceof ModelsError && error.code === "oauth") {
				throw new ChatGptBackendError("auth_required", error.message, null, { cause: error });
			}
			throw error;
		}
		const accessToken = auth?.auth.apiKey;
		if (accessToken === undefined) {
			throw new ChatGptBackendError("auth_required", "ChatGPT login is required", null);
		}
		return accessToken;
	}
}

// openai-codex の資格情報は accountId も持つが、getAuth はアクセストークンしか返さない。
// pi-ai 自身もリクエストのたびにトークンから取り出しているので、それに合わせる。
function accountIdFromAccessToken(accessToken: string): string {
	const payload = accessToken.split(".")[1];
	if (payload !== undefined) {
		try {
			const parsed = accessTokenPayloadSchema.safeParse(
				JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
			);
			if (parsed.success) return parsed.data[JWT_AUTH_CLAIM].chatgpt_account_id;
		} catch {
			// 下の auth_required に揃える
		}
	}
	throw new ChatGptBackendError(
		"auth_required",
		"ChatGPT access token does not contain an account id",
		null,
	);
}

function truncate(text: string): string {
	return text.length <= MAX_ERROR_BODY_LENGTH ? text : `${text.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}
