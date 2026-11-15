import type { ConversationSession } from "../../conversation/domain/conversation-session";
import type { LunaEvent } from "../../event/domain/luna-event";

const VOICE_EVENT_SOURCE = "discord/voice";
export const VOICE_UTTERANCE_EVENT_TYPE = "discord.voice.utterance.v1";

export type VoiceMode = "text" | "voice";

// 読み上げを遮られた時点で、ルナがどこまで話せたか。
export type InterruptedSpeech = Readonly<{
	played: readonly string[];
	cut: string | null;
	dropped: readonly string[];
}>;

export type VoiceChannelRef = Readonly<{ guildId: string; channelId: string; name: string }>;

export function createVoiceUtteranceEvent(
	input: Readonly<{
		id: string;
		session: ConversationSession;
		channel: VoiceChannelRef;
		userId: string;
		speaker: string;
		text: string;
		mode: VoiceMode;
		interrupted: InterruptedSpeech | undefined;
		occurredAt: Date;
	}>,
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
			...(input.interrupted === undefined
				? {}
				: {
						interrupted: {
							played: [...input.interrupted.played],
							cut: input.interrupted.cut,
							dropped: [...input.interrupted.dropped],
						},
					}),
		},
	};
}
