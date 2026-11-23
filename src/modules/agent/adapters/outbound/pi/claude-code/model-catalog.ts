import type { Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

export const PROVIDER_ID = "claude-code";
export const API_ID = "claude-code-stream-json";
export const BASE_URL = "process://claude-code";

type ClaudeCodeModel = Model<typeof API_ID>;

// Claude Code の --model にはモデルIDをそのまま渡す。文脈長も pi-ai の定義どおり（2026-11-19 に Max で 1M を実測）。
const CLAUDE_CODE_MODEL_IDS = [
	"claude-fable-5-2",
	"claude-opus-5-5",
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
] as const;

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

function catalogModel(id: string): ClaudeCodeModel {
	const builtin = BUILTIN_ANTHROPIC_MODELS.get(id);
	if (builtin === undefined) {
		throw new Error(`anthropic/${id} is missing from pi-ai`);
	}
	const off = builtin.thinkingLevelMap?.off;
	CAPABILITIES.set(id, {
		adaptiveThinking: builtin.compat?.forceAdaptiveThinking ?? false,
		// pi は thinking.type: disabled を拒むモデルを off: null で表す。
		disabledThinking: off === undefined || off != null,
		nativeToolChanges: builtin.compat?.supportsMidConvoToolChanges ?? false,
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
	};
}

export const CLAUDE_CODE_MODELS: readonly ClaudeCodeModel[] =
	CLAUDE_CODE_MODEL_IDS.map(catalogModel);

function capabilities(model: string): Capabilities {
	const found = CAPABILITIES.get(model);
	if (found === undefined) {
		throw new Error(`Unknown Claude Code model: ${model}`);
	}
	return found;
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
