import { Readable } from "node:stream";

import {
	AudioPlayerStatus,
	EndBehaviorType,
	NoSubscriberBehavior,
	StreamType,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
} from "@discordjs/voice";
import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import { Events, PermissionFlagsBits } from "discord.js";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import OpusScript from "opusscript";

import type { LoggerPort } from "../../observability/ports/logger-port";
import type { VoiceChannelRef } from "../domain/voice-event";
import type { VoicePcm } from "../ports/speech-port";
import type { VoiceGatewayPort, VoiceLink, VoiceLinkHandlers } from "../ports/voice-gateway-port";
import type { SpeechDetector } from "./silero-vad";

const RECEIVE_SAMPLE_RATE = 16_000;
const PLAY_SAMPLE_RATE = 48_000;
const PLAY_CHANNELS = 2;
// Discordの音声は20msごとのOpusフレームで送る。
const FRAME_SAMPLES = 960;
const FRAME_BYTES = FRAME_SAMPLES * PLAY_CHANNELS * 2;
const READY_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 5_000;
// @discordjs/voice は人がいるVCに後から入ると復号に失敗し続けることがあり、自分では立ち直らない。
const DECRYPT_FAILURE_RECOVERY_MS = 5_000;
const DECRYPT_FAILURE_MESSAGE = "Failed to decrypt a packet";

type GatewayOptions = Readonly<{
	silenceMs: number;
	createDetector: () => SpeechDetector;
	logger: LoggerPort;
	now: () => number;
}>;

export class DiscordVoiceGateway implements VoiceGatewayPort {
	constructor(
		private readonly client: Client,
		private readonly options: GatewayOptions,
	) {}

	async resolveChannel(channelId: string): Promise<VoiceChannelRef> {
		const channel = await this.#fetchVoiceChannel(channelId);
		const me = channel.guild.members.me;
		if (
			!channel.joinable ||
			me == null ||
			!channel.permissionsFor(me).has(PermissionFlagsBits.Speak)
		) {
			throw new Error(`Luna cannot connect to or speak in voice channel ${channelId}.`);
		}
		return { guildId: channel.guild.id, channelId: channel.id, name: channel.name };
	}

	async findUserChannel(userId: string): Promise<VoiceChannelRef> {
		for (const guild of this.client.guilds.cache.values()) {
			const channelId = guild.voiceStates.cache.get(userId)?.channelId;
			if (channelId != null) return await this.resolveChannel(channelId);
		}
		throw new Error(`User ${userId} is not in a voice channel Luna can see.`);
	}

	async connect(
		channelRef: VoiceChannelRef,
		handlers: VoiceLinkHandlers,
		options: Readonly<{ muted: boolean }>,
	): Promise<VoiceLink> {
		const link = new DiscordVoiceLink(
			this.client,
			await this.#fetchVoiceChannel(channelRef.channelId),
			handlers,
			this.options,
			options.muted,
		);
		await link.open();
		return link;
	}

	async speakerName(channel: VoiceChannelRef, userId: string): Promise<string> {
		const guild = await this.client.guilds.fetch(channel.guildId);
		return (await guild.members.fetch(userId)).displayName;
	}

	async #fetchVoiceChannel(channelId: string): Promise<VoiceBasedChannel> {
		const channel = await this.client.channels.fetch(channelId);
		if (channel == null || !channel.isVoiceBased()) {
			throw new Error(`Channel ${channelId} is not a voice channel.`);
		}
		return channel;
	}
}

type Listening = { decoder: OpusScript; chunks: Float32Array[]; speechStarted: boolean };

class DiscordVoiceLink implements VoiceLink {
	readonly #player: AudioPlayer;
	readonly #encoder = new OpusScript(PLAY_SAMPLE_RATE, PLAY_CHANNELS, OpusScript.Application.VOIP);
	readonly #listening = new Map<string, Listening>();
	readonly #detectors = new Map<string, SpeechDetector>();
	readonly #onVoiceState: (oldState: VoiceState, newState: VoiceState) => void;
	#connection: VoiceConnection | undefined;
	#playing: PromiseWithResolvers<boolean> | undefined;
	#decryptFailingSince: number | undefined;
	#reconnecting = false;
	#closed = false;
	#muted: boolean;

	constructor(
		private readonly client: Client,
		private readonly channel: VoiceBasedChannel,
		private readonly handlers: VoiceLinkHandlers,
		private readonly options: GatewayOptions,
		muted: boolean,
	) {
		this.#muted = muted;
		this.#player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
		this.#player.on(AudioPlayerStatus.Idle, () => {
			this.#playing?.resolve(true);
			this.#playing = undefined;
		});
		this.#player.on("error", (error) => {
			options.logger.error("voice.playback.error", { error });
		});
		this.#onVoiceState = (oldState, newState) => {
			if (oldState.channelId === channel.id || newState.channelId === channel.id) {
				handlers.onHumanCount(this.humanCount);
			}
		};
	}

	get humanCount(): number {
		return this.channel.members.filter((member) => !member.user.bot).size;
	}

	async open(): Promise<void> {
		this.client.on(Events.VoiceStateUpdate, this.#onVoiceState);
		try {
			await this.#join();
		} catch (error: unknown) {
			this.disconnect();
			throw error;
		}
	}

	play(audio: VoicePcm): Promise<boolean> {
		this.#playing?.resolve(false);
		const playing = Promise.withResolvers<boolean>();
		this.#playing = playing;
		this.#player.play(
			createAudioResource(Readable.from(this.#encode(audio.pcm)), { inputType: StreamType.Opus }),
		);
		return playing.promise;
	}

	stop(): void {
		const playing = this.#playing;
		this.#playing = undefined;
		this.#player.stop(true);
		playing?.resolve(false);
	}

	setMuted(muted: boolean): void {
		this.#muted = muted;
		this.#connection?.rejoin({ channelId: this.channel.id, selfDeaf: false, selfMute: muted });
	}

	disconnect(): void {
		this.#closed = true;
		this.client.off(Events.VoiceStateUpdate, this.#onVoiceState);
		this.stop();
		this.#destroyConnection();
	}

	async #join(): Promise<void> {
		const connection = joinVoiceChannel({
			channelId: this.channel.id,
			guildId: this.channel.guild.id,
			adapterCreator: this.channel.guild.voiceAdapterCreator,
			selfDeaf: false,
			selfMute: this.#muted,
			debug: true,
		});
		this.#connection = connection;
		connection.on("debug", (message) => {
			if (message.includes(DECRYPT_FAILURE_MESSAGE)) this.#onDecryptFailure();
		});
		connection.on("error", (error) => {
			this.options.logger.error("voice.connection.error", { error });
		});
		connection.on(VoiceConnectionStatus.Disconnected, () => {
			void this.#onDisconnected(connection);
		});
		await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
		connection.subscribe(this.#player);
		connection.receiver.speaking.on("start", (userId) => {
			this.#listen(connection, userId);
		});
	}

	#listen(connection: VoiceConnection, userId: string): void {
		if (this.#listening.has(userId) || this.channel.members.get(userId)?.user.bot !== false) return;
		const listening: Listening = {
			// Discordの音声は48kHzステレオだが、Opusは復号時に任意のレートとチャンネル数へ変換できる。
			decoder: new OpusScript(RECEIVE_SAMPLE_RATE, 1, OpusScript.Application.VOIP),
			chunks: [],
			speechStarted: false,
		};
		this.#listening.set(userId, listening);
		const detector = this.#detectorFor(userId);
		detector.reset();
		const stream = connection.receiver.subscribe(userId, {
			end: { behavior: EndBehaviorType.AfterSilence, duration: this.options.silenceMs },
		});
		stream.on("data", (packet: Buffer) => {
			this.#decryptFailingSince = undefined;
			try {
				const samples = toFloat32(listening.decoder.decode(packet));
				listening.chunks.push(samples);
				if (!listening.speechStarted && detector.accept(samples)) {
					listening.speechStarted = true;
					this.handlers.onSpeechStarted(userId);
				}
			} catch (error: unknown) {
				this.options.logger.warn("voice.decode.failed", { userId, error });
			}
		});
		stream.on("error", (error) => {
			this.options.logger.warn("voice.receive.error", { userId, error });
		});
		stream.once("close", () => {
			this.#listening.delete(userId);
			listening.decoder.delete();
			if (this.#closed || listening.chunks.length === 0) return;
			this.handlers.onUtterance(userId, concat(listening.chunks));
		});
	}

	#detectorFor(userId: string): SpeechDetector {
		const existing = this.#detectors.get(userId);
		if (existing !== undefined) return existing;
		const detector = this.options.createDetector();
		this.#detectors.set(userId, detector);
		return detector;
	}

	#onDecryptFailure(): void {
		const now = this.options.now();
		this.#decryptFailingSince ??= now;
		if (this.#reconnecting || now - this.#decryptFailingSince < DECRYPT_FAILURE_RECOVERY_MS) return;
		this.options.logger.warn("voice.decrypt.recovering", { channelId: this.channel.id });
		void this.#reconnect();
	}

	async #reconnect(): Promise<void> {
		this.#reconnecting = true;
		this.#decryptFailingSince = undefined;
		this.#destroyConnection();
		try {
			if (!this.#closed) await this.#join();
		} catch (error: unknown) {
			this.options.logger.error("voice.reconnect.failed", { error });
			this.#close();
		} finally {
			this.#reconnecting = false;
		}
	}

	async #onDisconnected(connection: VoiceConnection): Promise<void> {
		if (this.#closed || this.#reconnecting || connection !== this.#connection) return;
		try {
			// 別のVCへ移されたなど、Discord側で張り直している途中なら戻るのを待つ。
			await Promise.race([
				entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
				entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
			]);
		} catch {
			this.options.logger.warn("voice.connection.lost", { channelId: this.channel.id });
			this.#close();
		}
	}

	#close(): void {
		if (this.#closed) return;
		this.disconnect();
		this.handlers.onClosed();
	}

	#destroyConnection(): void {
		const connection = this.#connection;
		this.#connection = undefined;
		this.#listening.clear();
		if (connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed) {
			connection.destroy();
		}
	}

	#encode(pcm: Buffer): Buffer[] {
		const packets: Buffer[] = [];
		for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
			const frame = Buffer.alloc(FRAME_BYTES);
			pcm.copy(frame, 0, offset, Math.min(offset + FRAME_BYTES, pcm.length));
			packets.push(this.#encoder.encode(frame, FRAME_SAMPLES));
		}
		return packets;
	}
}

function toFloat32(pcm: Buffer): Float32Array {
	const samples = new Float32Array(pcm.length / 2);
	for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32_768;
	return samples;
}

function concat(chunks: readonly Float32Array[]): Float32Array {
	const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
