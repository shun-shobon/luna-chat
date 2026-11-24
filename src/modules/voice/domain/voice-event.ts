import type { ConversationSession } from "../../conversation/domain/conversation-session";
import type { LunaEvent } from "../../event/domain/luna-event";
import { toRecordJson } from "./voice-record";
import type { VoiceRecordEntry } from "./voice-record";

const VOICE_EVENT_SOURCE = "discord/voice";
export const VOICE_UTTERANCE_EVENT_TYPE = "discord.voice.utterance.v1";
export const VOICE_DELEGATED_EVENT_TYPE = "discord.voice.delegated.v1";
export const VOICE_TRANSCRIPT_EVENT_TYPE = "discord.voice.transcript.v1";

export type VoiceMode = "text" | "voice";

export type VoiceChannelRef = Readonly<{ guildId: string; channelId: string; name: string }>;

type EventBase = Readonly<{
	id: string;
	session: ConversationSession;
	channel: VoiceChannelRef;
	occurredAt: Date;
}>;

export function createVoiceUtteranceEvent(
	input: EventBase & Readonly<{ userId: string; speaker: string; text: string; mode: VoiceMode }>,
): LunaEvent {
	return {
		id: input.id,
		type: VOICE_UTTERANCE_EVENT_TYPE,
		source: VOICE_EVENT_SOURCE,
		subject: input.session.key,
		occurredAt: input.occurredAt.toISOString(),
		data: {
			guild_id: input.channel.guildId,
			channel_id: input.channel.channelId,
			user_id: input.userId,
			speaker: input.speaker,
			text: input.text,
			mode: input.mode,
		},
	};
}

// 音声モードの表が、調べ物や操作を会話のエージェント（裏）に頼む。
export function createVoiceDelegatedEvent(
	input: EventBase & Readonly<{ request: string; transcript: readonly VoiceRecordEntry[] }>,
): LunaEvent {
	return {
		id: input.id,
		type: VOICE_DELEGATED_EVENT_TYPE,
		source: VOICE_EVENT_SOURCE,
		subject: input.session.key,
		occurredAt: input.occurredAt.toISOString(),
		data: {
			guild_id: input.channel.guildId,
			channel_id: input.channel.channelId,
			request: input.request,
			transcript: input.transcript.map(toRecordJson),
		},
	};
}

// 音声モードを終える時に、裏へまだ渡していない会話記録を渡す。
export function createVoiceTranscriptEvent(
	input: EventBase & Readonly<{ transcript: readonly VoiceRecordEntry[] }>,
): LunaEvent {
	return {
		id: input.id,
		type: VOICE_TRANSCRIPT_EVENT_TYPE,
		source: VOICE_EVENT_SOURCE,
		subject: input.session.key,
		occurredAt: input.occurredAt.toISOString(),
		data: {
			guild_id: input.channel.guildId,
			channel_id: input.channel.channelId,
			transcript: input.transcript.map(toRecordJson),
		},
	};
}
