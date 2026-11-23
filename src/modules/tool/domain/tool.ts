import type { JsonValue } from "../../../shared/json";

export type ToolOrigin =
	| Readonly<{
			kind: "conversation";
			session: Readonly<{ key: string; source: string; context: JsonValue }>;
	  }>
	| Readonly<{ kind: "event"; eventId: string; eventType: string }>
	| Readonly<{ kind: "task"; taskId: string }>;

export type ActivityHandle = Readonly<{
	// 作業を止めた後の通知は捨てる。
	// message はエージェントの入力（kind 付きのメッセージ）と同じ形。
	notify(
		message: Readonly<{ kind: string; text: string }>,
		options: Readonly<{ urgent: boolean; replaceKey: string | null }>,
	): void;
	// 作業が自分で終わった時に呼ぶ。止められた時は呼ばなくてよい。
	end(): void;
}>;

// ツールが、実行が終わってもセッションの中で続く作業を始めるための口。
export interface ToolActivities {
	// stop はセッションが作業を止める時（閉じる、取消、シャットダウン）に一度だけ呼ばれる。
	begin(stop: () => Promise<void>): ActivityHandle;
}

// ownerId は1回の実行（会話セッション、イベント実行、タスクの試行）ごとの識別子で、タイピングや待機の解放に使う。
export type ToolExecution = Readonly<{
	ownerId: string;
	origin: ToolOrigin;
	activities: ToolActivities;
	signal: AbortSignal;
}>;

// value はモデルへJSON文字列として返すだけなので、JSONに直列化できる任意の値を許す。
export type ToolInvocation = Readonly<{ target: JsonValue; value: unknown }>;
