import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { findCutPoint } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { toLlmMessage } from "./luna-input-message";

const SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

export type CompactionState = Readonly<{
	// 添字ではなく参照で持つ。run ごとに pi が配列を作り直すため。
	firstKeptMessage: AgentMessage;
	summary: string;
	summaryMessage: UserMessage;
}>;

export type PromptUsage = Readonly<{ index: number; tokens: number }>;

// 入力として送ったトークン数。usage は input・cacheRead・cacheWrite に分かれており、和が送った量になる。
export function findLastPromptUsage(messages: readonly AgentMessage[]): PromptUsage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message !== undefined && isUsableAssistant(message)) {
			const { input, cacheRead, cacheWrite } = message.usage;
			return { index, tokens: input + cacheRead + cacheWrite };
		}
	}
	return undefined;
}

function isUsableAssistant(message: AgentMessage): message is AssistantMessage {
	return (
		message.role === "assistant" &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted"
	);
}

export type SummarizationTarget = Readonly<{
	cutIndex: number;
	messages: Message[];
}>;

export function selectSummarizationTarget(
	messages: readonly AgentMessage[],
	previous: CompactionState | undefined,
	keepRecentTokens: number,
): SummarizationTarget | undefined {
	const startIndex = previous === undefined ? 0 : messages.indexOf(previous.firstKeptMessage);
	if (startIndex < 0) {
		return undefined;
	}
	const entries = messages.map((message, index) => toSessionEntry(message, index));
	const { firstKeptEntryIndex } = findCutPoint(
		entries,
		startIndex,
		messages.length,
		keepRecentTokens,
	);
	const target = messages.slice(startIndex, firstKeptEntryIndex).flatMap((message) => {
		const converted = toLlmMessage(message);
		return converted === undefined || converted.role === "system" ? [] : [converted];
	});
	return target.length === 0 ? undefined : { cutIndex: firstKeptEntryIndex, messages: target };
}

// findCutPoint は SessionEntry を受け取るが、見るのは type と message だけ。
function toSessionEntry(message: AgentMessage, index: number): SessionEntry {
	return {
		type: "message",
		id: String(index),
		parentId: index === 0 ? null : String(index - 1),
		timestamp: new Date(message.timestamp).toISOString(),
		message: toLlmMessage(message) ?? message,
	};
}

export function createCompactionState(
	firstKeptMessage: AgentMessage,
	summary: string,
	timestamp: number,
): CompactionState {
	return {
		firstKeptMessage,
		summary,
		summaryMessage: {
			role: "user",
			content: [{ type: "text", text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` }],
			timestamp,
		},
	};
}

// 記録の messages は書き換えず、送る分だけ「切り口より前の system → 要約 → 切り口以降」に置き換える。
// 切り口より前の system も残すのは、ツールの追加・削除の宣言が後続の system に載ることがあるため。
export function applyCompaction(
	messages: readonly AgentMessage[],
	state: CompactionState,
): AgentMessage[] | undefined {
	const cutIndex = messages.indexOf(state.firstKeptMessage);
	if (cutIndex < 0) {
		return undefined;
	}
	return [
		...messages.slice(0, cutIndex).filter((message) => message.role === "system"),
		state.summaryMessage,
		...messages.slice(cutIndex),
	];
}
