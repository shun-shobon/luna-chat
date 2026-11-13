import type { JsonValue } from "../../../shared/json";

export type ToolOrigin =
	| Readonly<{
			kind: "conversation";
			session: Readonly<{ key: string; source: string; context: JsonValue }>;
	  }>
	| Readonly<{ kind: "event"; eventId: string; eventType: string }>
	| Readonly<{ kind: "task"; taskId: string }>;

// ownerId は1回の実行（会話セッション、イベント実行、タスクの試行）ごとの識別子で、タイピングや待機の解放に使う。
export type ToolExecution = Readonly<{
	ownerId: string;
	origin: ToolOrigin;
	signal: AbortSignal;
}>;

// value はモデルへJSON文字列として返すだけなので、JSONに直列化できる任意の値を許す。
export type ToolInvocation = Readonly<{ target: JsonValue; value: unknown }>;
