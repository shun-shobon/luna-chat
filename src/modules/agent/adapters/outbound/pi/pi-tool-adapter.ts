import type {
	AgentTool as PiAgentTool,
	AgentToolResult as PiAgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import type { AgentTool, AgentToolResult } from "../../../ports/outbound/agent-session-port";

export function toPiAgentTool(tool: AgentTool): PiAgentTool {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		async execute(_toolCallId, params: unknown, signal) {
			// pi は実行中の run の signal を必ず渡すが、型の上では省略可能になっている。
			const result = await tool.execute(params, signal ?? new AbortController().signal);
			return toPiToolResult(result);
		},
	};
}

// pi の約束では失敗を content だけで表してはならず、isError を立てる（例外はそのまま pi が error の結果にする）。
function toPiToolResult(result: AgentToolResult): PiAgentToolResult<undefined> {
	const content: (TextContent | ImageContent)[] = [];
	if (result.text !== "" || result.images.length === 0) {
		content.push({ type: "text", text: result.text });
	}
	for (const image of result.images) {
		content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	return result.isError
		? { content, details: undefined, isError: true }
		: { content, details: undefined };
}
