import { SerialQueue } from "../../../shared/serial-queue";
import type {
	AcceptedConversationEvent,
	ConversationSession,
} from "../../conversation/domain/conversation-session";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { ToolOrigin } from "../../tool/domain/tool";
import { createVoiceUtteranceEvent } from "../domain/voice-event";
import type { InterruptedSpeech, VoiceChannelRef, VoiceMode } from "../domain/voice-event";
import type { SpeechSynthesizerPort } from "../ports/speech-port";
import type { TranscriberPort } from "../ports/transcriber-port";
import type { VoiceGatewayPort, VoiceLink } from "../ports/voice-gateway-port";
import { SpeechQueue } from "./speech-queue";

class VoiceToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceToolError";
	}
}

type Joined = {
	readonly channel: VoiceChannelRef;
	readonly link: VoiceLink;
	readonly speech: SpeechQueue;
	session: ConversationSession;
	mode: VoiceMode;
	emptyTimer: ReturnType<typeof setTimeout> | undefined;
	// 人が一度でもいたか。いた人が全員抜けたらすぐ出て、誰もいないVCに入った時だけ来るのを待つ。
	hadHumans: boolean;
	readonly interrupted: Map<string, InterruptedSpeech>;
};

type VoiceChannelServiceDependencies = Readonly<{
	gateway: VoiceGatewayPort;
	transcriber: TranscriberPort;
	synthesizer: SpeechSynthesizerPort;
	conversation: Readonly<{ accept(input: AcceptedConversationEvent): boolean }>;
	// 声で話せる会話（Discordの会話）かどうか。紐づけ先として受け付けるかを決める。
	isVoiceSession: (session: ConversationSession) => boolean;
	createId: () => string;
	now: () => Date;
	logger: LoggerPort;
	// 誰もいないVCに入った時に、人が来るのを待つ時間。
	emptyJoinWaitMs: number;
}>;

export type VoiceJoinTarget = Readonly<{ channelId: string }> | Readonly<{ userId: string }>;

// ルナが入っているVC（同時に1つ）と、その紐づけ先・モード・読み上げを受け持つ。
export class VoiceChannelService {
	readonly #operations = new SerialQueue();
	#joined: Joined | undefined;

	constructor(private readonly dependencies: VoiceChannelServiceDependencies) {}

	isBound(sessionKey: string): boolean {
		return this.#joined?.session.key === sessionKey;
	}

	join(
		input: Readonly<{ target: VoiceJoinTarget; mode: VoiceMode }>,
		origin: ToolOrigin,
	): Promise<Readonly<{ channel: VoiceChannelRef; mode: VoiceMode }>> {
		const session = this.#requireVoiceSession(origin);
		return this.#operations.run(async () => {
			const channel =
				"channelId" in input.target
					? await this.dependencies.gateway.resolveChannel(input.target.channelId)
					: await this.dependencies.gateway.findUserChannel(input.target.userId);
			const joined = this.#joined;
			if (joined !== undefined && joined.channel.channelId === channel.channelId) {
				joined.session = session;
				if (input.mode === "text") joined.speech.clear();
				if (joined.mode !== input.mode) joined.link.setMuted(input.mode === "text");
				joined.mode = input.mode;
				this.dependencies.logger.info("voice.rebound", this.#describe(joined));
				return { channel, mode: input.mode };
			}
			if (joined !== undefined) this.#disconnect(joined, "moved");
			this.#joined = await this.#connect(channel, session, input.mode);
			return { channel, mode: input.mode };
		});
	}

	leave(): Promise<Readonly<{ channel: VoiceChannelRef }>> {
		return this.#operations.run(() => {
			const joined = this.#joined;
			if (joined === undefined) throw new VoiceToolError("Not in a voice channel.");
			this.#disconnect(joined, "requested");
			return { channel: joined.channel };
		});
	}

	say(text: string, origin: ToolOrigin): void {
		const joined = this.#joined;
		if (joined?.mode !== "voice") {
			throw new VoiceToolError(
				"voice_say works only while Luna is in a voice channel in voice mode.",
			);
		}
		if (origin.kind !== "conversation" || origin.session.key !== joined.session.key) {
			throw new VoiceToolError(
				"voice_say works only from the conversation the voice channel is bound to.",
			);
		}
		joined.speech.say(text);
	}

	async stop(): Promise<void> {
		await this.#operations.run(() => {
			if (this.#joined !== undefined) this.#disconnect(this.#joined, "shutdown");
		});
	}

	#requireVoiceSession(origin: ToolOrigin): ConversationSession {
		if (origin.kind !== "conversation" || !this.dependencies.isVoiceSession(origin.session)) {
			throw new VoiceToolError("voice_join works only from a Discord conversation.");
		}
		return origin.session;
	}

	async #connect(
		channel: VoiceChannelRef,
		session: ConversationSession,
		mode: VoiceMode,
	): Promise<Joined> {
		let joined: Joined | undefined;
		const link = await this.dependencies.gateway.connect(
			channel,
			{
				onUtterance: (userId, samples) => {
					if (joined !== undefined) void this.#hear(joined, userId, samples);
				},
				onSpeechStarted: (userId) => {
					if (joined?.mode !== "voice") return;
					const interrupted = joined.speech.interrupt();
					if (interrupted === undefined) return;
					joined.interrupted.set(userId, interrupted);
					this.dependencies.logger.info("voice.speech.interrupted", { userId, ...interrupted });
				},
				onHumanCount: (count) => {
					if (joined !== undefined) this.#watchEmpty(joined, count);
				},
				onClosed: () => {
					void this.#operations.run(() => {
						if (joined !== undefined && this.#joined === joined) this.#disconnect(joined, "closed");
					});
				},
			},
			{ muted: mode === "text" },
		);
		joined = {
			channel,
			link,
			speech: new SpeechQueue({
				synthesizer: this.dependencies.synthesizer,
				playback: link,
				logger: this.dependencies.logger,
			}),
			session,
			mode,
			emptyTimer: undefined,
			hadHumans: false,
			interrupted: new Map(),
		};
		this.#watchEmpty(joined, link.humanCount);
		this.dependencies.logger.info("voice.joined", this.#describe(joined));
		return joined;
	}

	#disconnect(joined: Joined, reason: string): void {
		clearTimeout(joined.emptyTimer);
		joined.speech.clear();
		joined.link.disconnect();
		if (this.#joined === joined) this.#joined = undefined;
		this.dependencies.logger.info("voice.left", { ...this.#describe(joined), reason });
	}

	#watchEmpty(joined: Joined, humanCount: number): void {
		if (humanCount > 0) {
			joined.hadHumans = true;
			clearTimeout(joined.emptyTimer);
			joined.emptyTimer = undefined;
			return;
		}
		const leave = (): void => {
			void this.#operations.run(() => {
				if (this.#joined === joined) this.#disconnect(joined, "empty");
			});
		};
		if (joined.hadHumans) leave();
		else joined.emptyTimer ??= setTimeout(leave, this.dependencies.emptyJoinWaitMs);
	}

	async #hear(joined: Joined, userId: string, samples: Float32Array): Promise<void> {
		const logger = this.dependencies.logger;
		try {
			const [result, speaker] = await Promise.all([
				this.dependencies.transcriber.transcribe(samples),
				this.#speakerName(joined.channel, userId),
			]);
			logger.info("voice.utterance.transcribed", {
				userId,
				durationSec: samples.length / 16_000,
				decodeMs: result.elapsedMs,
				chars: result.text.length,
			});
			if (result.text.length === 0 || this.#joined !== joined) return;
			const interrupted = joined.interrupted.get(userId);
			joined.interrupted.delete(userId);
			joined.speech.markTurn();
			const event = createVoiceUtteranceEvent({
				id: this.dependencies.createId(),
				session: joined.session,
				channel: joined.channel,
				userId,
				speaker,
				text: result.text,
				mode: joined.mode,
				interrupted,
				occurredAt: this.dependencies.now(),
			});
			if (!this.dependencies.conversation.accept({ session: joined.session, event })) {
				logger.warn("voice.utterance.rejected", { userId, eventId: event.id });
			}
		} catch (error: unknown) {
			logger.error("voice.utterance.failed", { userId, error });
		}
	}

	async #speakerName(channel: VoiceChannelRef, userId: string): Promise<string> {
		try {
			return await this.dependencies.gateway.speakerName(channel, userId);
		} catch (error: unknown) {
			this.dependencies.logger.warn("voice.speaker_name_failed", { userId, error });
			return userId;
		}
	}

	#describe(joined: Joined) {
		return {
			guildId: joined.channel.guildId,
			channelId: joined.channel.channelId,
			mode: joined.mode,
			sessionKey: joined.session.key,
		};
	}
}
