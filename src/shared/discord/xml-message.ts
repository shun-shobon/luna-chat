import type { RuntimeReaction } from "./runtime-reaction";
import type { RuntimeSticker } from "./runtime-sticker";

type XmlAttachmentInput = {
  id: string;
  name: string | null;
  url: string;
};

type XmlMessageBlockInput = {
  attachments: XmlAttachmentInput[];
  authorId: string;
  authorIsBot: boolean;
  authorName: string;
  channelId?: string;
  content: string;
  createdAt: string;
  id: string;
  mentionedBot?: boolean;
  reactions?: RuntimeReaction[];
  replyTo?: XmlMessageBlockInput;
  stickers?: RuntimeSticker[];
};

export function formatXmlMessageBlock(input: XmlMessageBlockInput, indent = "  "): string {
  const lines = [`${indent}${formatMessageOpenTag(input)}`];

  if (input.replyTo) {
    lines.push(
      `${indent}  <reply_to>`,
      formatXmlMessageBlock(input.replyTo, `${indent}    `),
      `${indent}  </reply_to>`,
    );
  }

  lines.push(formatXmlContent(input.content, `${indent}  `));

  if (input.stickers && input.stickers.length > 0) {
    lines.push(`${indent}  <stickers>`);
    for (const sticker of input.stickers) {
      lines.push(
        `${indent}    <sticker id="${sticker.id}" name="${sticker.name}" format="${sticker.format}" url="${sticker.url}" description="${sticker.description ?? ""}" guild_id="${sticker.guildId ?? ""}" />`,
      );
    }
    lines.push(`${indent}  </stickers>`);
  }

  if (input.attachments.length > 0) {
    lines.push(`${indent}  <attachments>`);
    for (const attachment of input.attachments) {
      lines.push(
        `${indent}    <attachment id="${attachment.id}" name="${attachment.name ?? ""}" url="${attachment.url}" />`,
      );
    }
    lines.push(`${indent}  </attachments>`);
  }

  if (input.reactions && input.reactions.length > 0) {
    lines.push(`${indent}  <reactions>`);
    for (const reaction of input.reactions) {
      lines.push(
        `${indent}    <reaction emoji="${reaction.emoji}" count="${reaction.count}" self_reacted="${reaction.selfReacted ? "true" : "false"}" />`,
      );
    }
    lines.push(`${indent}  </reactions>`);
  }

  lines.push(`${indent}</message>`);
  return lines.join("\n");
}

function formatMessageOpenTag(input: XmlMessageBlockInput): string {
  const channelIdAttribute = input.channelId ? ` channel_id="${input.channelId}"` : "";
  const mentionedBotAttribute =
    input.mentionedBot === undefined
      ? ""
      : ` mentioned_bot="${input.mentionedBot ? "true" : "false"}"`;
  return `<message id="${input.id}"${channelIdAttribute} author_id="${input.authorId}" author_name="${input.authorName}" author_is_bot="${input.authorIsBot ? "true" : "false"}" created_at="${input.createdAt}"${mentionedBotAttribute}>`;
}

function formatXmlContent(content: string, indent: string): string {
  if (content.length === 0) {
    return `${indent}<content></content>`;
  }

  return [`${indent}<content>`, content, `${indent}</content>`].join("\n");
}
