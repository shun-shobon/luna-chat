import { createProvider } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";

import { getClaudeStatus } from "./claude-cli";
import { BASE_URL, CLAUDE_CODE_MODELS, PROVIDER_ID } from "./model-catalog";
import type { API_ID } from "./model-catalog";
import { streamClaudeCode } from "./stream";

export type ClaudeCodeProviderOptions = Readonly<{
	// luna のシェルから人やエージェントが使う claude と、ログインや設定を混ぜないための専用の設定ディレクトリ。
	configDir: string;
}>;

// 資格情報は Claude Code が持つ。luna は読みも保存もせず、ログイン済みかどうかだけを claude auth status で確かめる。
export function claudeCodeProvider(options: ClaudeCodeProviderOptions): Provider<typeof API_ID> {
	const env = { CLAUDE_CONFIG_DIR: options.configDir };
	const stream: typeof streamClaudeCode = (model, context, streamOptions) =>
		streamClaudeCode(model, context, { ...streamOptions, env: { ...streamOptions?.env, ...env } });
	return createProvider<typeof API_ID>({
		id: PROVIDER_ID,
		name: "Claude Code",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "Claude Code login",
				async check({ signal }) {
					const status = await getClaudeStatus({ ...process.env, ...env }, signal);
					if (!status.available || !status.loggedIn) return undefined;
					return {
						type: status.subscription ? "oauth" : "api_key",
						source:
							status.subscription && status.plan !== undefined
								? `Claude Code ${status.plan}`
								: "Claude Code CLI",
					};
				},
				resolve({ signal }) {
					signal.throwIfAborted();
					// Claude Code の子プロセスが自分で認証するため、pi へ渡す鍵は形だけの値でよい。
					return Promise.resolve({
						auth: { apiKey: "external-process" },
						source: "Claude Code CLI",
					});
				},
			},
		},
		models: CLAUDE_CODE_MODELS,
		api: { stream, streamSimple: stream },
	});
}
