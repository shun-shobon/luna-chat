import type { Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

export const PROVIDER_ID = "claude-code";
export const API_ID = "claude-code-stream-json";
export const BASE_URL = "process://claude-code";

type ClaudeCodeModel = Model<typeof API_ID>;

// route は Claude Code の --model に渡す値。contextWindow は Claude Code 経由で使える長さで、API の定義とは違うことがある。
const CLAUDE_CODE_ROUTES: Readonly<Record<string, { route: string; contextWindow: number }>> = {
	"claude-fable-5-2": { route: "claude-fable-5-2", contextWindow: 200_000 },
	"claude-opus-5-5": { route: "claude-opus-5-5", contextWindow: 200_000 },
	"claude-sonnet-5-5": { route: "claude-sonnet-5-5", contextWindow: 200_000 },
	"claude-haiku-5-5": { route: "claude-haiku-5-5", contextWindow: 200_000 },
};

type Capabilities = {
	adaptiveThinking: boolean;
	disabledThinking: boolean;
	nativeToolChanges: boolean;
};

const BUILTIN_ANTHROPIC_MODELS = new Map(
	anthropicProvider()
		.getModels()
		.map((model) => [model.id, model]),
);

const CAPABILITIES = new Map<string, Capabilities>();

function catalogModel(id: string, contextWindow: number): ClaudeCodeModel {
	const builtin = BUILTIN_ANTHROPIC_MODELS.get(id);
	if (builtin === undefined) {
		throw new Error(`anthropic/${id} is missing from pi-ai`);
	}
	const off = builtin.thinkingLevelMap?.off;
	CAPABILITIES.set(id, {
		adaptiveThinking: builtin.compat?.forceAdaptiveThinking === true,
		// pi は thinking.type: disabled を拒むモデルを off: null で表す。
		disabledThinking: off === undefined || off != null,
		nativeToolChanges: builtin.compat?.supportsMidConvoToolChanges === true,
	});
	const {
		api: _api,
		provider: _provider,
		baseUrl: _baseUrl,
		compat: _compat,
		...metadata
	} = builtin;
	return {
		...metadata,
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		// サブスクの使用枠で払うため、従量の料金を載せない。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
	};
}

export const CLAUDE_CODE_MODELS: readonly ClaudeCodeModel[] = Object.entries(
	CLAUDE_CODE_ROUTES,
).map(([id, { contextWindow }]) => catalogModel(id, contextWindow));

function capabilities(model: string): Capabilities {
	const found = CAPABILITIES.get(model);
	if (found === undefined) {
		throw new Error(`Unknown Claude Code model: ${model}`);
	}
	return found;
}

export function nativeModel(model: string): string {
	const entry = CLAUDE_CODE_ROUTES[model];
	if (entry === undefined) {
		throw new Error(`Unknown Claude Code model: ${model}`);
	}
	return entry.route;
}

export function supportsAdaptiveThinking(model: string): boolean {
	return capabilities(model).adaptiveThinking;
}

export function supportsDisabledThinking(model: string): boolean {
	return capabilities(model).disabledThinking;
}

export function supportsNativeToolChanges(model: string): boolean {
	return capabilities(model).nativeToolChanges;
}
