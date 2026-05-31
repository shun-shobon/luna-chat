import type { RuntimeMessage } from "../../../conversation/domain/runtime-message";

export type NonEmptyRuntimeMessages = [RuntimeMessage, ...RuntimeMessage[]];

export type DiscordPromptContext =
  | {
      kind: "channel";
      channelName: string;
    }
  | {
      kind: "dm";
    };

export type AiInput = {
  context: DiscordPromptContext;
  currentMessages: NonEmptyRuntimeMessages;
  loadRecentMessages: () => Promise<RuntimeMessage[]>;
};

export type HeartbeatInput = {
  prompt: string;
  source?: "heartbeat" | "cron";
};

export interface AiService {
  generateReply(input: AiInput): Promise<void>;
  generateHeartbeat(input: HeartbeatInput): Promise<void>;
}
