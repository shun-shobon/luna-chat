import type { AuthEvent, AuthPrompt, Models } from "@earendil-works/pi-ai";

import { OPENAI_CODEX_PROVIDER_ID } from "./chatgpt-backend";

// openai-codex のログイン方法の選択肢のうち、ブラウザを開けない常駐環境で使えるもの。
const DEVICE_CODE_LOGIN_METHOD = "device_code";

// ChatGPT にデバイスコードでログインし、資格情報を models の資格情報ストアへ保存する。
export async function loginWithDeviceCode(models: Models, signal: AbortSignal): Promise<void> {
	await models.login(OPENAI_CODEX_PROVIDER_ID, "oauth", {
		signal,
		prompt: (prompt) => Promise.resolve(answerPrompt(prompt)),
		notify: (event) => {
			process.stdout.write(`${describeEvent(event)}\n`);
		},
	});
}

function answerPrompt(prompt: AuthPrompt): string {
	if (
		prompt.type === "select" &&
		prompt.options.some((option) => option.id === DEVICE_CODE_LOGIN_METHOD)
	) {
		return DEVICE_CODE_LOGIN_METHOD;
	}
	throw new Error(`Device code login received an unexpected prompt: ${prompt.type}`);
}

function describeEvent(event: AuthEvent): string {
	if (event.type === "device_code") {
		return `Open ${event.verificationUri} and enter the code: ${event.userCode}`;
	}
	if (event.type === "auth_url") return `Open ${event.url}`;
	return event.message;
}
