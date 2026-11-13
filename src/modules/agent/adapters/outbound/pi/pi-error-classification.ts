import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";

// pi はエラーを errorMessage の文字列でしか返さないため、HTTP の状態とプロバイダーの生イベントを別に集めて判定に使う。
export type RequestFailureSignals = Readonly<{
	httpStatus: number | undefined;
	providerErrorStatus: number | undefined;
	providerErrorCode: string | undefined;
}>;

export const EMPTY_REQUEST_FAILURE_SIGNALS: RequestFailureSignals = {
	httpStatus: undefined,
	providerErrorStatus: undefined,
	providerErrorCode: undefined,
};

export type AgentErrorKind = "usage_limit" | "auth_required" | "transient" | "fatal";

const USAGE_LIMIT_CODES = new Set([
	"usage_limit_reached",
	"usage_not_included",
	"rate_limit_exceeded",
]);
const USAGE_LIMIT_MESSAGE = /usage.?limit|usage_not_included/iu;

// pi-ai が認証の解決や資格情報の読み出しに失敗したときの定型文（ModelsError の auth/oauth と codex の資格情報検査）。
// ModelsError はストリームに入る時点で文字列になり、code が失われる。
const AUTH_FAILURE_MESSAGE =
	/Provider is not configured:|OAuth refresh failed for|OAuth refresh returned a token that expires too soon|OAuth auth derivation failed for|Credential store read failed for|API key auth check failed|No API key for provider:|Failed to extract accountId from token/u;

// isRetryableAssistantError が拾わない codex の切断。
const EXTRA_TRANSIENT_MESSAGE = /closed before response\.completed|ECONNRESET|EPIPE/iu;

export function classifyAgentError(
	message: AssistantMessage,
	signals: RequestFailureSignals,
): AgentErrorKind {
	const errorMessage = message.errorMessage ?? "";
	const status = signals.providerErrorStatus ?? errorStatus(signals.httpStatus);

	if (
		status === 429 ||
		(signals.providerErrorCode !== undefined && USAGE_LIMIT_CODES.has(signals.providerErrorCode)) ||
		USAGE_LIMIT_MESSAGE.test(errorMessage)
	) {
		return "usage_limit";
	}
	if (status === 401 || AUTH_FAILURE_MESSAGE.test(errorMessage)) {
		return "auth_required";
	}
	if (status !== undefined) {
		if (status >= 500 || status === 408) {
			return "transient";
		}
		if (status >= 400) {
			return "fatal";
		}
	}
	if (isRetryableAssistantError(message) || EXTRA_TRANSIENT_MESSAGE.test(errorMessage)) {
		return "transient";
	}
	return "fatal";
}

function errorStatus(status: number | undefined): number | undefined {
	return status !== undefined && status >= 400 ? status : undefined;
}

const providerErrorEventSchema = z.union([
	z.object({
		type: z.literal("error"),
		status: z.number().optional(),
		code: z.string().optional(),
		error: z
			.object({
				type: z.string().nullish(),
				code: z.string().nullish(),
			})
			.nullish(),
	}),
	z.object({
		type: z.literal("response.failed"),
		response: z.object({
			error: z.object({ code: z.string().nullish() }).nullish(),
		}),
	}),
]);

export type ProviderErrorEvent = Readonly<{
	status: number | undefined;
	code: string | undefined;
}>;

export function parseProviderErrorEvent(raw: unknown): ProviderErrorEvent | undefined {
	const parsed = providerErrorEventSchema.safeParse(raw);
	if (!parsed.success) {
		return undefined;
	}
	const event = parsed.data;
	if (event.type === "response.failed") {
		return { status: undefined, code: event.response.error?.code ?? undefined };
	}
	return {
		status: event.status,
		code: event.error?.type ?? event.error?.code ?? event.code ?? undefined,
	};
}
