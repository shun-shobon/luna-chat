import type { JsonObject } from "../../../../shared/json";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelSelection = Readonly<{
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}>;

export type AgentModel = Readonly<{
	provider: string;
	model: string;
	displayName: string;
	supportedThinkingLevels: readonly ThinkingLevel[];
}>;

export type AgentImage = Readonly<{ data: string; mimeType: string }>;

// モデルへ渡す入力。kind で種類を区別したまま記録し、LLMには <luna_input kind="..."> で包んだuser文として渡す。
export type AgentInputMessage = Readonly<{ kind: string; text: string }>;

export type AgentToolResult = Readonly<{
	text: string;
	images: readonly AgentImage[];
	isError: boolean;
}>;

export interface AgentTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: JsonObject;
	execute(argumentsValue: unknown, signal: AbortSignal): Promise<AgentToolResult>;
}

// アダプターが自前で用意する汎用ツール。どれを渡すかは実行の種類ごとに決める。
export type HarnessToolName =
	| "exec_command"
	| "write_stdin"
	| "stop_background"
	| "read"
	| "edit"
	| "write"
	| "view_image"
	| "web_run"
	| "image_gen";

export type AgentSessionKind = "conversation" | "event" | "worker";

export type AgentSessionSpec = Readonly<{
	kind: AgentSessionKind;
	label: string;
	cwd: string;
	systemPrompt: string;
	model: ModelSelection;
	tools: readonly AgentTool[];
	harnessTools: readonly HarnessToolName[];
	// リクエストごとに呼び、真なら高速モード（ChatGPTのFast、service_tier priority）で送る。使用枠の消費が増える。
	fastMode: () => boolean;
	// ツールが始める、セッションの外で続く作業。汎用ツールのバックグラウンド実行と同じく、通知と停止をセッションが受ける。
	activities: SessionActivities;
}>;

// 続いている作業がセッションへ渡す通知。replaceKey が同じで、まだ run に入れていない通知は新しいほうだけを残す。
export type ActivityNotice = Readonly<{
	message: AgentInputMessage;
	urgent: boolean;
	replaceKey: string | null;
}>;

export type ActivityListener = Readonly<{
	notify(notice: ActivityNotice): void;
	// 通知を出さずに止まった時に呼ぶ。
	stopped(): void;
}>;

export interface SessionActivities {
	count(): number;
	stopAll(): Promise<void>;
	// セッションを開いた時に一度だけ呼ぶ。それより前の通知は、つないだ時に渡す。
	connect(listener: ActivityListener): void;
}

// any は通知が届くまで、urgent は急ぎの通知が届くまで待つ。
export type ActivityWaitFilter = "any" | "urgent";

// none は、待っていた通知が届かないまま続いている作業がなくなった（または初めからない）ことを表す。
export type ActivityWakeup = "none" | "notice" | "urgent";

export type AgentRunFailureReason =
	| "usage_limit"
	| "auth_required"
	| "transient_exhausted"
	| "fatal";

export type AgentRunResult =
	| Readonly<{ status: "completed"; finalText: string | null }>
	| Readonly<{
			status: "failed";
			reason: AgentRunFailureReason;
			message: string;
	  }>
	| Readonly<{ status: "aborted" }>;

export type AgentSessionPhase = "idle" | "running" | "retry_wait" | "compacting" | "closed";

export type AgentSessionStatus = Readonly<{
	id: string;
	kind: AgentSessionKind;
	label: string;
	model: ModelSelection;
	phase: AgentSessionPhase;
	phaseSince: string;
	retries: number;
}>;

export interface AgentSession {
	readonly id: string;
	// アイドルになるまで実行する。実行中に呼ぶと例外になる。
	run(messages: readonly AgentInputMessage[]): Promise<AgentRunResult>;
	// 実行中なら次のLLMリクエストの前に入る。アイドルなら次の run の入力の後に入る。
	steer(message: AgentInputMessage): void;
	abort(): Promise<void>;
	// 続いている作業（汎用ツールのバックグラウンド実行と SessionActivities）か、まだ run に入れていない通知があるか。
	hasActivity(): boolean;
	// filter に合う通知が届いた（または既にある）時点で解決する。届いた通知は次の run の入力の前に入るため、
	// run([]) で続けられる。urgent で待つ間に届いた急ぎでない通知は、解決させずに保留する。
	waitForActivity(filter: ActivityWaitFilter): Promise<ActivityWakeup>;
	// 続いている作業を通知を出さずに止め、まだ run に入れていない通知も捨てる。
	stopActivities(): Promise<void>;
	setModel(model: ModelSelection): void;
	close(): Promise<void>;
	status(): AgentSessionStatus;
}

type AgentAuthState = "ready" | "auth_required" | "missing";

export type UsageWindow = Readonly<{
	usedPercent: number;
	windowMinutes: number;
	resetsAt: string | null;
}>;

export type UsageSnapshot = Readonly<{
	fetchedAt: string;
	planType: string | null;
	limits: readonly Readonly<{
		limitId: string;
		primary: UsageWindow | null;
		secondary: UsageWindow | null;
	}>[];
}>;

export type AgentRuntimeStatus = Readonly<{
	auth: AgentAuthState;
	usage: UsageSnapshot | null;
	lastFailure: Readonly<{ at: string; message: string }> | null;
	sessions: readonly AgentSessionStatus[];
}>;

export interface AgentRuntimePort {
	open(spec: AgentSessionSpec): AgentSession;
	listModels(): readonly AgentModel[];
	status(): AgentRuntimeStatus;
}
