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
}>;

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
	// 動いているバックグラウンド実行か、まだ run に入れていない完了通知があるか。
	hasBackground(): boolean;
	// 完了通知が届けば true、通知なしにすべて止まった（または何もない）なら false で解決する。
	// 届いた通知は次の run の入力の前に入るため、run([]) で続けられる。
	waitForBackground(): Promise<boolean>;
	// 残っているバックグラウンド実行を完了通知を出さずに止め、まだ run に入れていない完了通知も捨てる。
	stopBackground(): Promise<void>;
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
