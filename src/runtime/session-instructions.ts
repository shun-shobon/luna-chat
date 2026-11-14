import type { AgentSessionKind } from "../modules/agent/ports/outbound/agent-session-port";
import { DISCORD_CAPABILITY_INSTRUCTIONS } from "../modules/discord/discord-capability-instructions";
import {
	TASK_BOARD_INSTRUCTIONS,
	TASK_WORKER_INSTRUCTIONS,
} from "../modules/task/task-instructions";
import {
	EVENT_INSTRUCTIONS,
	LUNA_CONVERSATION_GUIDE,
	LUNA_CORE_INSTRUCTIONS,
	SESSION_END_INSTRUCTIONS,
} from "./developer-instructions";

export const SESSION_DEVELOPER_INSTRUCTIONS: Readonly<Record<AgentSessionKind, readonly string[]>> =
	{
		conversation: [
			LUNA_CORE_INSTRUCTIONS,
			LUNA_CONVERSATION_GUIDE,
			SESSION_END_INSTRUCTIONS,
			DISCORD_CAPABILITY_INSTRUCTIONS,
			TASK_BOARD_INSTRUCTIONS,
		],
		event: [
			LUNA_CORE_INSTRUCTIONS,
			LUNA_CONVERSATION_GUIDE,
			EVENT_INSTRUCTIONS,
			DISCORD_CAPABILITY_INSTRUCTIONS,
			TASK_BOARD_INSTRUCTIONS,
		],
		worker: [TASK_WORKER_INSTRUCTIONS],
	};
