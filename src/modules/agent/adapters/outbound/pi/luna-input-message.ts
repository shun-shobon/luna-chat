import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

import type { AgentInputMessage } from "../../../ports/outbound/agent-session-port";

export type LunaInputMessage = Readonly<{
	role: "luna_input";
	kind: string;
	text: string;
	timestamp: number;
}>;

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		luna_input: LunaInputMessage;
	}
}

export function createLunaInputMessage(
	input: AgentInputMessage,
	timestamp: number,
): LunaInputMessage {
	return { role: "luna_input", kind: input.kind, text: input.text, timestamp };
}

function formatLunaInput(message: LunaInputMessage): string {
	// 本文はJSONなので、`</` を同じ意味の `<\/` にしてDiscordの投稿などから外側のタグを閉じられないようにする。
	return `<luna_input kind="${escapeAttribute(message.kind)}">\n${message.text.replaceAll("</", "<\\/")}\n</luna_input>`;
}

export function toLlmMessage(message: AgentMessage): Message | undefined {
	switch (message.role) {
		case "system":
		case "user":
		case "assistant":
		case "toolResult":
			return message;
		case "luna_input":
			return {
				role: "user",
				content: [{ type: "text", text: formatLunaInput(message) }],
				timestamp: message.timestamp,
			};
		default:
			// pi-coding-agent が型に足す独自ロール（bashExecution など）。このアダプターは作らない。
			return undefined;
	}
}

export function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
	return messages.flatMap((message) => {
		const converted = toLlmMessage(message);
		return converted === undefined ? [] : [converted];
	});
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
