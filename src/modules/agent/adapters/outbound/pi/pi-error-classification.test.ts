import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	classifyAgentError,
	EMPTY_REQUEST_FAILURE_SIGNALS,
	parseProviderErrorEvent,
} from "./pi-error-classification";
import type { RequestFailureSignals } from "./pi-error-classification";

function errorMessage(text: string) {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage: text });
}

function signals(overrides: Partial<RequestFailureSignals>): RequestFailureSignals {
	return { ...EMPTY_REQUEST_FAILURE_SIGNALS, ...overrides };
}

describe("classifyAgentError", () => {
	it.each([
		["SSEの429", "Request failed", signals({ httpStatus: 429 })],
		["WebSocketの429", "Codex error: limit", signals({ providerErrorStatus: 429 })],
		[
			"usage_limit_reached",
			"Codex error: x",
			signals({ providerErrorCode: "usage_limit_reached" }),
		],
		[
			"codexの定型文",
			"You have hit your ChatGPT usage limit (plus plan).",
			EMPTY_REQUEST_FAILURE_SIGNALS,
		],
	])("使用上限を判定する: %s", (_name, text, input) => {
		expect(classifyAgentError(errorMessage(text), input)).toBe("usage_limit");
	});

	it.each([
		["401", "Unauthorized", signals({ httpStatus: 401 })],
		["未設定", "Provider is not configured: openai-codex", EMPTY_REQUEST_FAILURE_SIGNALS],
		[
			"OAuth更新失敗",
			"OAuth refresh failed for openai-codex: invalid_grant",
			EMPTY_REQUEST_FAILURE_SIGNALS,
		],
		["APIキーなし", "No API key for provider: openai-codex", EMPTY_REQUEST_FAILURE_SIGNALS],
	])("認証失敗を判定する: %s", (_name, text, input) => {
		expect(classifyAgentError(errorMessage(text), input)).toBe("auth_required");
	});

	it.each([
		["5xx", "Bad gateway", signals({ httpStatus: 502 })],
		["WebSocketの5xx", "Codex error", signals({ providerErrorStatus: 503 })],
		["接続失敗", "fetch failed", EMPTY_REQUEST_FAILURE_SIGNALS],
		[
			"タイムアウト",
			"Codex SSE response headers timed out after 1000ms",
			EMPTY_REQUEST_FAILURE_SIGNALS,
		],
		["WebSocketの切断", "WebSocket closed 1006", EMPTY_REQUEST_FAILURE_SIGNALS],
		[
			"完了前の切断",
			"WebSocket stream closed before response.completed",
			EMPTY_REQUEST_FAILURE_SIGNALS,
		],
		["成功ステータスの後の切断", "socket hang up", signals({ httpStatus: 200 })],
	])("一時的なエラーを判定する: %s", (_name, text, input) => {
		expect(classifyAgentError(errorMessage(text), input)).toBe("transient");
	});

	it.each([
		["400", "Invalid schema", signals({ httpStatus: 400 })],
		["400は本文の語より優先する", "request timeout field is invalid", signals({ httpStatus: 400 })],
		["不明", "Something unexpected", EMPTY_REQUEST_FAILURE_SIGNALS],
	])("それ以外は致命的とする: %s", (_name, text, input) => {
		expect(classifyAgentError(errorMessage(text), input)).toBe("fatal");
	});
});

describe("parseProviderErrorEvent", () => {
	it("WebSocketのerrorイベントから状態と種別を取り出す", () => {
		expect(
			parseProviderErrorEvent({
				type: "error",
				status: 429,
				error: { type: "usage_limit_reached", resets_at: 1_800_000_000 },
			}),
		).toEqual({ status: 429, code: "usage_limit_reached" });
	});

	it("response.failedからコードを取り出す", () => {
		expect(
			parseProviderErrorEvent({
				type: "response.failed",
				response: { error: { code: "server_error" } },
			}),
		).toEqual({ status: undefined, code: "server_error" });
	});

	it.each([
		["関係ないイベント", { type: "response.output_text.delta", delta: "a" }],
		["形が違う", { type: "error", status: "429" }],
		["オブジェクトでない", "error"],
	])("エラーでないものは無視する: %s", (_name, raw) => {
		expect(parseProviderErrorEvent(raw)).toBeUndefined();
	});
});
