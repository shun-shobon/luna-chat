import type { RuntimeMessage } from "../../../conversation/domain/runtime-message";

export type AiInput = {
  channelName: string;
  currentMessage: RuntimeMessage;
  recentMessages: RuntimeMessage[];
};

export type HeartbeatInput = {
  prompt: string;
};

export interface AiService {
  generateReply(input: AiInput): Promise<void>;
  generateHeartbeat(input: HeartbeatInput): Promise<void>;
}
