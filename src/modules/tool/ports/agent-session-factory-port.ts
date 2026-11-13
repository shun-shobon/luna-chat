import type {
	AgentRunResult,
	AgentSession,
	ModelSelection,
} from "../../agent/ports/outbound/agent-session-port";
import type { ToolOrigin } from "../domain/tool";

export type OpenedAgentSession = Readonly<{ ownerId: string; session: AgentSession }>;

// 実行の種類ごとにシステムプロンプト・ツール・モデルを組み立ててセッションを開く。組み立てはコンポジションルートが担う。
export type OpenAgentSession = (
	origin: ToolOrigin,
	model?: ModelSelection,
) => Promise<OpenedAgentSession>;

export function describeRunFailure(
	result: Exclude<AgentRunResult, { status: "completed" }>,
): string {
	return result.status === "aborted"
		? "Agent run was aborted"
		: `${result.reason}: ${result.message}`;
}
