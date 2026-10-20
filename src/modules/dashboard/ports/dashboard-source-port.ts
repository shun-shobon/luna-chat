import type { AgentRuntimeStatus } from "../../agent/ports/outbound/agent-runtime-port";
import type { AutomationStatus } from "../../automation/ports/automation-status";
import type { ConversationStatus } from "../../conversation/domain/conversation-status";
import type { EventExecutionStatus } from "../../event/ports/event-execution-port";
import type { RecentLogRecord } from "../../observability/ports/logger-port";
import type { TaskBoardStatus } from "../../task/domain/task";

export interface DashboardSourcePort {
	activity(): readonly RecentLogRecord[];
	agent(): AgentRuntimeStatus;
	automation(): AutomationStatus;
	conversations(): readonly ConversationStatus[];
	events(): readonly EventExecutionStatus[];
	tasks(): TaskBoardStatus;
}
