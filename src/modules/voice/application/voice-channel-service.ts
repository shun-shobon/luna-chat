import { SerialQueue } from "../../../shared/serial-queue";
import type {
	AcceptedConversationEvent,
	ConversationSession,
} from "../../conversation/domain/conversation-session";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { ToolOrigin } from "../../tool/domain/tool";
import {
	createVoiceDelegatedEvent,
	createVoiceTranscriptEvent,
	createVoiceUtteranceEvent,
} from "../domain/voice-event";
import type { VoiceChannelRef, VoiceMode } from "../domain/voice-event";
import type { VoiceRecordEntry } from "../domain/voice-record";
import type { InterruptClassifierPort } from "../ports/interrupt-classifier-port";
import type { SpeechSynthesizerPort } from "../ports/speech-port";
import type { TranscriberPort } from "../ports/transcriber-port";
import type { VoiceGatewayPort, VoiceLink } from "../ports/voice-gateway-port";
import { SpeechOutput } from "./speech-output";
import { TurnTracker } from "./turn-tracker";
import type { Turn } from "./turn-tracker";
import type { VoiceResponder } from "./voice-responder";
import { VoiceSession } from "./voice-session";

class VoiceToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceToolError";
	}
}

type Joined = {
	readonly channel: VoiceChannelRef;
	readonly link: VoiceLink;
	readonly turns: TurnTracker;
	session: ConversationSession;
	mode: VoiceMode;
	// 音声モードの間だけある。
	voice: VoiceSession | undefined;
	emptyTimer: ReturnType<typeof setTimeout> | undefined;
	// 人が一度でもいたか。いた人が全員抜けたらすぐ出て、誰もいないVCに入った時だけ来るのを待つ。
	hadHumans: boolean;
	// 裏へ渡し、まだ実行が終わっていない依頼のイベントID。
	readonly delegations: Set<string>;
	readonly speakers: Map<string, Promise<string>>;
};

type VoiceChannelServiceDependencies = Readonly<{
	gateway: VoiceGatewayPort;
	transcriber: TranscriberPort;
	synthesizer: SpeechSynthesizerPort;
	classifier: InterruptClassifierPort;
	// 音声モードに入るたびに、その時の人格と記憶で表を開く。
	openResponder(): Promise<VoiceResponder>;
	conversation: Readonly<{ accept(input: AcceptedConversationEvent): boolean }>;
	// 声で話せる会話（Discordの会話）かどうか。紐づけ先として受け付けるかを決める。
	isVoiceSession: (session: ConversationSession) => boolean;
	createId: () => string;
	now: () => Date;
	monotonic: () => number;
	logger: LoggerPort;
	// 誰もいないVCに入った時に、人が来るのを待つ時間。
	emptyJoinWaitMs: number;
	turn: Readonly<{ silenceMs: number; turnWaitMs: number; unfinishedTurnWaitMs: number }>;
}>;

export type VoiceJoinTarget = Readonly<{ channelId: string }> | Readonly<{ userId: string }>;

// エージェントが入っているVC（同時に1つ）と、その紐づけ先・モード、音声モードの会話の進行を受け持つ。
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
				// 音声モードを終える時の会話記録は、それまでの紐づけ先へ渡す。
				await this.#switchMode(joined, input.mode);
				joined.session = session;
				this.dependencies.logger.info("voice.rebound", this.#describe(joined));
				return { channel, mode: input.mode };
			}
			if (joined !== undefined) await this.#disconnect(joined, "moved");
			this.#joined = await this.#connect(channel, session, input.mode);
			return { channel, mode: input.mode };
		});
	}

	leave(): Promise<Readonly<{ channel: VoiceChannelRef }>> {
		return this.#operations.run(async () => {
			const joined = this.#joined;
			if (joined === undefined) throw new VoiceToolError("Not in a voice channel.");
			await this.#disconnect(joined, "requested");
			return { channel: joined.channel };
		});
	}

	// 裏が依頼の結果を表へ返す。表が間を見て伝える。
	report(text: string, origin: ToolOrigin): void {
		const joined = this.#joined;
		if (joined?.voice === undefined) {
			throw new VoiceToolError(
				"voice_report works only while you are in a voice channel in voice mode.",
			);
		}
		if (origin.kind !== "conversation" || origin.session.key !== joined.session.key) {
			throw new VoiceToolError(
				"voice_report works only from the conversation the voice channel is bound to.",
			);
		}
		joined.voice.report(text);
	}

	// 会話の実行が終わった。裏へ渡した依頼の実行も終わる。
	onBatchSettled(eventIds: readonly string[]): void {
		const joined = this.#joined;
		if (joined === undefined) return;
		for (const eventId of eventIds) joined.delegations.delete(eventId);
	}

	async stop(): Promise<void> {
		await this.#operations.run(async () => {
			if (this.#joined !== undefined) await this.#disconnect(this.#joined, "shutdown");
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
		const turns = new TurnTracker(
			{
				transcriber: this.dependencies.transcriber,
				speakerName: (userId) =>
					joined === undefined ? Promise.resolve(userId) : this.#speakerName(joined, userId),
				logger: this.dependencies.logger,
				now: this.dependencies.monotonic,
				...this.dependencies.turn,
			},
			{
				onDraft: (turn) => joined?.voice?.draft(turn),
				onCommit: (turn) => {
					if (joined === undefined || this.#joined !== joined) return;
					if (joined.voice === undefined) this.#deliverUtterance(joined, turn);
					else joined.voice.commit(turn);
				},
				onDiscard: () => joined?.voice?.discard(),
			},
		);
		const link = await this.dependencies.gateway.connect(
			channel,
			{
				onSegment: (userId, samples) => {
					if (joined === undefined) return;
					if (joined.voice !== undefined) {
						joined.voice.segment(userId, samples);
						return;
					}
					turns.segment(userId, samples).catch((error: unknown) => {
						this.dependencies.logger.error("voice.segment.failed", { userId, error });
					});
				},
				onSpeechStarted: (userId) => {
					if (joined?.voice !== undefined) joined.voice.speechStarted(userId);
					else turns.speechStarted(userId);
				},
				onHumanCount: (count) => {
					if (joined !== undefined) this.#watchEmpty(joined, count);
				},
				onClosed: () => {
					void this.#operations.run(async () => {
						if (joined !== undefined && this.#joined === joined) {
							await this.#disconnect(joined, "closed");
						}
					});
				},
			},
			{ muted: mode === "text" },
		);
		joined = {
			channel,
			link,
			turns,
			session,
			mode,
			voice: undefined,
			emptyTimer: undefined,
			hadHumans: false,
			delegations: new Set(),
			speakers: new Map(),
		};
		try {
			await this.#switchMode(joined, mode);
		} catch (error: unknown) {
			turns.dispose();
			link.disconnect();
			throw error;
		}
		this.#watchEmpty(joined, link.humanCount);
		this.dependencies.logger.info("voice.joined", this.#describe(joined));
		return joined;
	}

	async #switchMode(joined: Joined, mode: VoiceMode): Promise<void> {
		if (joined.mode === mode && (mode === "text" || joined.voice !== undefined)) return;
		if (mode === "voice") {
			joined.voice = this.#openSession(joined, await this.dependencies.openResponder());
		} else {
			await this.#endVoice(joined);
		}
		if (joined.mode !== mode) joined.link.setMuted(mode === "text");
		joined.mode = mode;
	}

	#openSession(joined: Joined, responder: VoiceResponder): VoiceSession {
		const { dependencies } = this;
		return new VoiceSession(
			{
				responder,
				output: new SpeechOutput({
					synthesizer: dependencies.synthesizer,
					playback: joined.link,
					logger: dependencies.logger,
					now: dependencies.monotonic,
				}),
				transcriber: dependencies.transcriber,
				classifier: dependencies.classifier,
				ongoingSpeech: (userId) => joined.link.ongoingSpeech(userId),
				speakerName: (userId) => this.#speakerName(joined, userId),
				back: {
					delegate: (request, transcript) => this.#delegate(joined, request, transcript),
					hear: (turn) => joined.delegations.size > 0 && this.#deliverUtterance(joined, turn),
				},
				logger: dependencies.logger,
				now: dependencies.monotonic,
				clock: dependencies.now,
			},
			joined.turns,
		);
	}

	// 音声モードを終え、裏へまだ渡していない会話記録を会話に残す。記憶の保存で振り返れるようにするため。
	async #endVoice(joined: Joined): Promise<void> {
		const voice = joined.voice;
		if (voice === undefined) return;
		joined.voice = undefined;
		const transcript = await voice.close();
		if (transcript.length === 0) return;
		const event = createVoiceTranscriptEvent({
			id: this.dependencies.createId(),
			session: joined.session,
			channel: joined.channel,
			transcript,
			occurredAt: this.dependencies.now(),
		});
		if (!this.dependencies.conversation.accept({ session: joined.session, event })) {
			this.dependencies.logger.warn("voice.transcript.rejected", { eventId: event.id });
		}
	}

	#delegate(joined: Joined, request: string, transcript: readonly VoiceRecordEntry[]): boolean {
		const event = createVoiceDelegatedEvent({
			id: this.dependencies.createId(),
			session: joined.session,
			channel: joined.channel,
			request,
			transcript,
			occurredAt: this.dependencies.now(),
		});
		if (!this.dependencies.conversation.accept({ session: joined.session, event })) {
			this.dependencies.logger.warn("voice.delegation.rejected", { eventId: event.id });
			return false;
		}
		joined.delegations.add(event.id);
		this.dependencies.logger.info("voice.delegated", { eventId: event.id, chars: request.length });
		return true;
	}

	#deliverUtterance(joined: Joined, turn: Turn): boolean {
		const event = createVoiceUtteranceEvent({
			id: this.dependencies.createId(),
			session: joined.session,
			channel: joined.channel,
			userId: turn.userId,
			speaker: turn.speaker,
			text: turn.text,
			mode: joined.mode,
			occurredAt: this.dependencies.now(),
		});
		const accepted = this.dependencies.conversation.accept({ session: joined.session, event });
		if (!accepted) {
			this.dependencies.logger.warn("voice.utterance.rejected", {
				userId: turn.userId,
				eventId: event.id,
			});
		}
		return accepted;
	}

	async #disconnect(joined: Joined, reason: string): Promise<void> {
		if (this.#joined === joined) this.#joined = undefined;
		clearTimeout(joined.emptyTimer);
		joined.turns.dispose();
		await this.#endVoice(joined);
		joined.link.disconnect();
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
			void this.#operations.run(async () => {
				if (this.#joined === joined) await this.#disconnect(joined, "empty");
			});
		};
		if (joined.hadHumans) leave();
		else joined.emptyTimer ??= setTimeout(leave, this.dependencies.emptyJoinWaitMs);
	}

	// 表示名は話すたびに引かず、VCにいる間は覚えておく。
	#speakerName(joined: Joined, userId: string): Promise<string> {
		const cached = joined.speakers.get(userId);
		if (cached !== undefined) return cached;
		const name = this.dependencies.gateway
			.speakerName(joined.channel, userId)
			.catch((error: unknown) => {
				this.dependencies.logger.warn("voice.speaker_name_failed", { userId, error });
				joined.speakers.delete(userId);
				return userId;
			});
		joined.speakers.set(userId, name);
		return name;
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
