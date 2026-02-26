import type { RuntimeReaction } from "./runtime-message";

type ReactionSource = {
  count: number;
  emojiId?: string | null;
  emojiName?: string | null;
  selfReacted: boolean;
};

export function toRuntimeReactions(
  sources: readonly ReactionSource[],
): RuntimeReaction[] | undefined {
  const reactions = sources
    .filter((source) => source.count > 0)
    .map((source) => {
      return {
        count: source.count,
        emoji: formatReactionEmoji(source),
        ...(source.selfReacted ? { selfReacted: true as const } : {}),
      };
    })
    .sort((left, right) => left.emoji.localeCompare(right.emoji, "ja"));

  return reactions.length > 0 ? reactions : undefined;
}

function formatReactionEmoji(input: Pick<ReactionSource, "emojiId" | "emojiName">): string {
  const emojiId = input.emojiId?.trim();
  const emojiName = input.emojiName?.trim();
  if (emojiName && emojiId) {
    return `${emojiName}:${emojiId}`;
  }
  if (emojiName) {
    return emojiName;
  }
  if (emojiId) {
    return `custom:${emojiId}`;
  }

  return "unknown";
}
