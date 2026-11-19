import type { JsonObject } from "../../../../shared/json";
import type { ModelSelection } from "./agent-session-port";

type ModelStreamTool = Readonly<{
	name: string;
	description: string;
	parameters: JsonObject;
}>;

// 1回の要求の応答をそのまま流す。ツールは実行せず、記録・圧縮・再試行も持たない。
export type ModelStreamSpec = Readonly<{
	model: ModelSelection;
	systemPrompt: string;
	tools: readonly ModelStreamTool[];
}>;

export type ModelStreamEvent =
	| Readonly<{ type: "text"; delta: string }>
	| Readonly<{ type: "tool_call"; name: string; arguments: unknown }>;

export interface ModelStream {
	// 失敗と signal による中断は例外で終わる。
	stream(prompt: string, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
	close(): Promise<void>;
}

export interface ModelStreamPort {
	open(spec: ModelStreamSpec): ModelStream;
}
