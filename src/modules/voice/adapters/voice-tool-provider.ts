import { z } from "zod";

import { defineTool } from "../../tool/ports/tool-provider";
import type { ToolProvider } from "../../tool/ports/tool-provider";
import type { VoiceChannelService, VoiceJoinTarget } from "../application/voice-channel-service";

const snowflake = z.string().regex(/^\d+$/u);
const joinInputSchema = z
	.strictObject({
		channel_id: snowflake.optional(),
		user_id: snowflake.optional(),
		mode: z.enum(["text", "voice"]),
	})
	.refine((input) => (input.channel_id === undefined) !== (input.user_id === undefined), {
		message: "Give exactly one of channel_id or user_id.",
	});
const leaveInputSchema = z.strictObject({});
const sayInputSchema = z.strictObject({ text: z.string().trim().min(1).max(500) });

export function createVoiceToolProvider(
	voice: Pick<VoiceChannelService, "join" | "leave" | "say">,
): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "voice_join",
				description:
					"Join a Discord voice channel and bind it to this conversation, so that what people say there arrives here as voice_utterance inputs. Give user_id to join the voice channel that person is in now (use this when someone asks you to come), or channel_id for a specific voice channel. mode text: reply in writing as usual, and Luna stays muted. mode voice: speak with voice_say. Calling it for the channel Luna is already in only rebinds it here and switches the mode; another channel moves Luna there.",
				inputSchema: joinInputSchema,
				parseInput: (input) => ({ target: toJoinTarget(input), mode: input.mode }),
				execute: async (input, execution) => {
					const joined = await voice.join(input, execution.origin);
					return {
						channel_id: joined.channel.channelId,
						channel_name: joined.channel.name,
						mode: joined.mode,
					};
				},
				describeTarget: (input) => ({ ...toTargetJson(input.target), mode: input.mode }),
			}),
			defineTool({
				name: "voice_leave",
				description: "Leave the voice channel Luna is in.",
				inputSchema: leaveInputSchema,
				parseInput: () => ({}),
				execute: async () => {
					const left = await voice.leave();
					return { channel_id: left.channel.channelId, channel_name: left.channel.name };
				},
				describeTarget: () => ({}),
			}),
			defineTool({
				name: "voice_say",
				description:
					"Say something out loud in the voice channel in voice mode. Calls are read aloud in order; the call returns before the speech is played.",
				inputSchema: sayInputSchema,
				parseInput: (input) => ({ text: input.text.trim() }),
				execute: (input, execution) => {
					voice.say(input.text, execution.origin);
					return Promise.resolve({ queued: true });
				},
				describeTarget: (input) => ({ chars: input.text.length }),
			}),
		]),
		release: async () => {},
	});
}

function toTargetJson(target: VoiceJoinTarget): Readonly<Record<string, string>> {
	return "channelId" in target ? { channel_id: target.channelId } : { user_id: target.userId };
}

function toJoinTarget(input: Readonly<{ channel_id?: string; user_id?: string }>): VoiceJoinTarget {
	if (input.channel_id !== undefined) return { channelId: input.channel_id };
	if (input.user_id !== undefined) return { userId: input.user_id };
	throw new Error("Give exactly one of channel_id or user_id.");
}
