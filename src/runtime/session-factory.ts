import { randomUUID } from "node:crypto";

import type {
	AgentRuntimePort,
	AgentSessionKind,
	HarnessToolName,
	ModelSelection,
} from "../modules/agent/ports/outbound/agent-session-port";
import type { ToolSet } from "../modules/tool/application/tool-set";
import type { ToolOrigin } from "../modules/tool/domain/tool";
import type { OpenAgentSession } from "../modules/tool/ports/agent-session-factory-port";
import { readWorkspaceBaseInstructions } from "../modules/workspace/application/workspace-instructions";

const HARNESS_TOOLS: readonly HarnessToolName[] = [
	"exec_command",
	"write_stdin",
	"stop_background",
	"read",
	"edit",
	"write",
	"view_image",
	"web_run",
	"image_gen",
];

type SessionProfile = Readonly<{
	developerInstructions: readonly string[];
	// 作業エージェントは依頼文だけで動けるため、人格と記憶は必要な時に自分で読ませる。
	includeWorkspaceInstructions: boolean;
	model: () => ModelSelection;
	tools: ToolSet;
}>;

export function buildSystemPrompt(input: {
	developerInstructions: readonly string[];
	skills: string;
	luna: string | undefined;
	memory: string | undefined;
}): string {
	return [
		...input.developerInstructions,
		input.skills,
		input.luna === undefined ? undefined : `# LUNA.md\n\n${input.luna}`,
		input.memory === undefined ? undefined : `# MEMORY.md\n\n${input.memory}`,
	]
		.filter((section) => section !== undefined && section.trim().length > 0)
		.join("\n\n");
}

export function createSessionFactory(input: {
	agent: AgentRuntimePort;
	createOwnerId?: (() => string) | undefined;
	profiles: Readonly<Record<AgentSessionKind, SessionProfile>>;
	readSkillsPrompt: () => string;
	workspaceDir: string;
}): OpenAgentSession {
	const createOwnerId = input.createOwnerId ?? randomUUID;
	return async (origin: ToolOrigin, model?: ModelSelection) => {
		const kind = sessionKindOf(origin);
		const profile = input.profiles[kind];
		const ownerId = createOwnerId();
		const instructions = profile.includeWorkspaceInstructions
			? await readWorkspaceBaseInstructions(input.workspaceDir)
			: { luna: undefined, memory: undefined };
		const session = input.agent.open({
			kind,
			label: describeOrigin(origin),
			cwd: input.workspaceDir,
			systemPrompt: buildSystemPrompt({
				developerInstructions: profile.developerInstructions,
				skills: input.readSkillsPrompt(),
				luna: instructions.luna,
				memory: instructions.memory,
			}),
			model: model ?? profile.model(),
			tools: profile.tools.bind({ ownerId, origin }),
			harnessTools: HARNESS_TOOLS,
		});
		return { ownerId, session };
	};
}

function sessionKindOf(origin: ToolOrigin): AgentSessionKind {
	return origin.kind === "task" ? "worker" : origin.kind;
}

function describeOrigin(origin: ToolOrigin): string {
	if (origin.kind === "conversation") return origin.session.key;
	if (origin.kind === "event") return origin.eventType;
	return `task:${origin.taskId}`;
}
