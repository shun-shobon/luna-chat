import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AcceptedConversationEvent,
	ConversationSession,
} from "../../conversation/domain/conversation-session";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { ToolOrigin } from "../../tool/domain/tool";
import type { VoiceChannelRef } from "../domain/voice-event";
import type { VoicePcm } from "../ports/speech-port";
import type { Transcription } from "../ports/transcriber-port";
import type { VoiceLink, VoiceLinkHandlers } from "../ports/voice-gateway-port";
import { VoiceChannelService } from "./voice-channel-service";

const TEXT_SESSION: ConversationSession = {
	key: "discord:guild_channel:1:10",
	source: "discord/main",
	context: { kind: "guild_channel", guildId: "1", channelId: "10" },
};
const OTHER_SESSION: ConversationSession = {
	key: "discord:guild_channel:1:11",
	source: "discord/main",
	context: { kind: "guild_channel", guildId: "1", channelId: "11" },
};
const from = (session: ConversationSession): ToolOrigin => ({ kind: "conversation", session });
const VC: VoiceChannelRef = { guildId: "1", channelId: "500", name: "雑談VC" };
const OTHER_VC: VoiceChannelRef = { guildId: "1", channelId: "501", name: "作業VC" };

const flush = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

type FakeLink = VoiceLink & {
	handlers: VoiceLinkHandlers;
	muted: boolean[];
	plays: Array<{ audio: string; done: PromiseWithResolvers<boolean> }>;
	disconnected: boolean;
	humans: number;
};

function setup(options: { humans?: number; transcribe?: () => Promise<Transcription> } = {}) {
	vi.useFakeTimers();
	const links: FakeLink[] = [];
	const accepted: AcceptedConversationEvent[] = [];
	const logger = createRecordingLogger();
	let ids = 0;
	const service = new VoiceChannelService({
		gateway: {
			resolveChannel: async (channelId) => {
				if (channelId === VC.channelId) return VC;
				if (channelId === OTHER_VC.channelId) return OTHER_VC;
				throw new Error(`Channel ${channelId} is not a voice channel.`);
			},
			findUserChannel: async (userId) => {
				if (userId === "42") return VC;
				throw new Error(`User ${userId} is not in a voice channel Luna can see.`);
			},
			connect: async (_channel, handlers, connectOptions) => {
				const link: FakeLink = {
					handlers,
					muted: [connectOptions.muted],
					plays: [],
					disconnected: false,
					humans: options.humans ?? 1,
					get humanCount() {
						return this.humans;
					},
					play(audio) {
						const done = Promise.withResolvers<boolean>();
						this.plays.push({ audio: audio.pcm.toString(), done });
						return done.promise;
					},
					stop() {
						this.plays.at(-1)?.done.resolve(false);
					},
					setMuted(muted) {
						this.muted.push(muted);
					},
					disconnect() {
						this.disconnected = true;
					},
				};
				links.push(link);
				return link;
			},
			speakerName: async (_channel, userId) => {
				if (userId === "unknown") throw new Error("Unknown Member");
				return "シュン";
			},
		},
		transcriber: {
			transcribe: options.transcribe ?? (async () => ({ text: "ねえルナ", elapsedMs: 80 })),
		},
		synthesizer: { synthesize: async (text): Promise<VoicePcm> => ({ pcm: Buffer.from(text) }) },
		conversation: {
			accept: (input) => {
				accepted.push(input);
				return true;
			},
		},
		isVoiceSession: (session) => session.source === "discord/main",
		createId: () => `event-${String(++ids)}`,
		now: () => new Date("2026-11-15T00:00:00.000Z"),
		logger,
		emptyJoinWaitMs: 60_000,
	});
	return { service, links, accepted, logger };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("VoiceChannelService", () => {
	it("呼んだ会話にVCを紐づけ、発話を voice_utterance としてその会話へすぐ渡す", async () => {
		const { service, links, accepted } = setup();

		await expect(
			service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION)),
		).resolves.toEqual({
			channel: VC,
			mode: "text",
		});
		expect(service.isBound(TEXT_SESSION.key)).toBe(true);
		links[0]?.handlers.onUtterance("42", new Float32Array(16_000));
		await flush();

		expect(accepted).toEqual([
			{
				session: TEXT_SESSION,
				event: {
					id: "event-1",
					type: "discord.voice.utterance.v1",
					source: "discord/voice",
					subject: TEXT_SESSION.key,
					occurredAt: "2026-11-15T00:00:00.000Z",
					data: {
						guild_id: "1",
						channel_id: "500",
						user_id: "42",
						speaker: "シュン",
						text: "ねえルナ",
						mode: "text",
					},
				},
			},
		]);
	});

	it("聞き取れなかった発話（空の文字起こし）は渡さない", async () => {
		const { service, links, accepted } = setup({
			transcribe: async () => ({ text: "", elapsedMs: 3 }),
		});
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		links[0]?.handlers.onUtterance("42", new Float32Array(1_000));
		await flush();

		expect(accepted).toEqual([]);
	});

	it("文字起こしに失敗したらログに残し、何も渡さない", async () => {
		const { service, links, accepted, logger } = setup({
			transcribe: async () => {
				throw new Error("decoder crashed");
			},
		});
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		links[0]?.handlers.onUtterance("42", new Float32Array(1_000));
		await flush();

		expect(accepted).toEqual([]);
		expect(logger.entries.map((entry) => entry.event)).toContain("voice.utterance.failed");
	});

	it("表示名を取れない話者はユーザーIDを speaker にする", async () => {
		const { service, links, accepted } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		links[0]?.handlers.onUtterance("unknown", new Float32Array(1_000));
		await flush();

		expect(accepted[0]?.event.data).toMatchObject({ speaker: "unknown", user_id: "unknown" });
	});

	it("同じVCへの voice_join は入り直さず、紐づけ先とモードだけを切り替える", async () => {
		const { service, links, accepted } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		await service.join({ target: { channelId: "500" }, mode: "voice" }, from(OTHER_SESSION));
		links[0]?.handlers.onUtterance("42", new Float32Array(1_000));
		await flush();

		expect(links).toHaveLength(1);
		expect(service.isBound(TEXT_SESSION.key)).toBe(false);
		expect(accepted[0]?.session).toEqual(OTHER_SESSION);
		expect(accepted[0]?.event.data).toMatchObject({ mode: "voice" });
	});

	it("別のVCへの voice_join は、出てから入る", async () => {
		const { service, links } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		await service.join({ target: { channelId: "501" }, mode: "text" }, from(TEXT_SESSION));

		expect(links.map((link) => link.disconnected)).toEqual([true, false]);
	});

	it.each<[string, ToolOrigin]>([
		["イベント実行", { kind: "event", eventId: "e1", eventType: "system.heartbeat.fired.v1" }],
		["作業エージェント", { kind: "task", taskId: "t1" }],
		[
			"Discord以外の会話",
			{
				kind: "conversation",
				session: { key: "home_assistant:assist:device:1", source: "home_assistant", context: {} },
			},
		],
	])("%sからの voice_join は失敗する", async (_title, origin) => {
		const { service, links } = setup();

		expect(() => service.join({ target: { channelId: "500" }, mode: "text" }, origin)).toThrow(
			"voice_join works only from a Discord conversation.",
		);
		expect(links).toHaveLength(0);
	});

	it("VCでないチャンネルへの voice_join は失敗し、入っているVCはそのまま", async () => {
		const { service, links } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		await expect(
			service.join({ target: { channelId: "999" }, mode: "text" }, from(TEXT_SESSION)),
		).rejects.toThrow("not a voice channel");
		expect(links[0]?.disconnected).toBe(false);
		expect(service.isBound(TEXT_SESSION.key)).toBe(true);
	});

	it("voice_leave で出て、入っていなければ失敗する", async () => {
		const { service, links } = setup();
		await expect(service.leave()).rejects.toThrow("Not in a voice channel.");
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		await expect(service.leave()).resolves.toEqual({ channel: VC });

		expect(links[0]?.disconnected).toBe(true);
		expect(service.isBound(TEXT_SESSION.key)).toBe(false);
	});

	it("voice_say は音声モードで紐づいた会話から呼んだ時だけ読み上げる", async () => {
		const { service, links } = setup();
		expect(() => service.say("やっほー", from(TEXT_SESSION))).toThrow("voice mode");
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
		expect(() => service.say("やっほー", from(TEXT_SESSION))).toThrow("voice mode");
		await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
		expect(() => service.say("やっほー", from(OTHER_SESSION))).toThrow("bound");

		service.say("やっほー", from(TEXT_SESSION));
		await flush();

		expect(links[0]?.plays.map((play) => play.audio)).toEqual(["やっほー"]);
	});

	it("読み上げ中に人の声を検知したら止め、その人の次の発話に遮られた内容を付ける", async () => {
		const { service, links, accepted } = setup();
		await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
		service.say("一文目", from(TEXT_SESSION));
		service.say("二文目", from(TEXT_SESSION));
		await flush();
		links[0]?.plays[0]?.done.resolve(true);
		await flush();

		links[0]?.handlers.onSpeechStarted("42");
		links[0]?.handlers.onUtterance("42", new Float32Array(1_000));
		links[0]?.handlers.onUtterance("42", new Float32Array(1_000));
		await flush();

		expect(accepted.map((input) => input.event.data)).toEqual([
			expect.objectContaining({ interrupted: { played: ["一文目"], cut: "二文目", dropped: [] } }),
			expect.not.objectContaining({ interrupted: expect.anything() }),
		]);
	});

	it("テキストモードでは人の声で何も止めない", async () => {
		const { service, links, accepted, logger } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		links[0]?.handlers.onSpeechStarted("42");
		links[0]?.handlers.onUtterance("42", new Float32Array(1_000));
		await flush();

		expect(accepted[0]?.event.data).not.toHaveProperty("interrupted");
		expect(logger.entries.map((entry) => entry.event)).not.toContain("voice.speech.interrupted");
	});

	it("音声モードからテキストモードに切り替えたら、読み上げを止める", async () => {
		const { service, links } = setup();
		await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
		service.say("長い話", from(TEXT_SESSION));
		await flush();
		const playing = links[0]?.plays[0]?.done.promise;

		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		await expect(playing).resolves.toBe(false);
	});

	it("いた人が全員抜けたら、すぐに出る", async () => {
		const { service, links } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		links[0]?.handlers.onHumanCount(0);
		await flush();

		expect(links[0]?.disconnected).toBe(true);
		expect(service.isBound(TEXT_SESSION.key)).toBe(false);
	});

	it("誰もいないVCに入ったら人が来るのを60秒待ち、来れば残り、来なければ出る", async () => {
		const { service, links } = setup({ humans: 0 });
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
		await service.join({ target: { channelId: "501" }, mode: "text" }, from(TEXT_SESSION));
		const [waited, unattended] = links;
		if (waited === undefined || unattended === undefined) throw new Error("not connected");
		expect(waited.disconnected).toBe(true);

		await vi.advanceTimersByTimeAsync(59_000);
		expect(unattended.disconnected).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(unattended.disconnected).toBe(true);
	});

	it("誰もいないVCで待っている間に人が来れば残り、その人が抜けたら出る", async () => {
		const { service, links } = setup({ humans: 0 });
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
		const link = links[0];
		if (link === undefined) throw new Error("not connected");

		link.handlers.onHumanCount(1);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(link.disconnected).toBe(false);
		link.handlers.onHumanCount(0);
		await flush();

		expect(link.disconnected).toBe(true);
	});

	it("user_id を指定すると、その人がいるVCに入る", async () => {
		const { service, links } = setup();

		await expect(
			service.join({ target: { userId: "42" }, mode: "voice" }, from(TEXT_SESSION)),
		).resolves.toEqual({ channel: VC, mode: "voice" });
		expect(links).toHaveLength(1);
	});

	it("VCにいない人を指定した voice_join は失敗する", async () => {
		const { service, links } = setup();

		await expect(
			service.join({ target: { userId: "7" }, mode: "voice" }, from(TEXT_SESSION)),
		).rejects.toThrow("is not in a voice channel");
		expect(links).toHaveLength(0);
	});

	it("テキストモードではミュートで入り、モードを切り替えるとミュートも切り替える", async () => {
		const { service, links } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
		await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		expect(links[0]?.muted).toEqual([true, false, true]);
	});

	it("音声モードではミュートせずに入る", async () => {
		const { service, links } = setup();

		await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));

		expect(links[0]?.muted).toEqual([false]);
	});

	it("Discord側でつながりが切れたら、入っていない状態に戻る", async () => {
		const { service, links } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		links[0]?.handlers.onClosed();
		await flush();

		expect(service.isBound(TEXT_SESSION.key)).toBe(false);
	});

	it("止めるとVCから出る", async () => {
		const { service, links } = setup();
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

		await service.stop();

		expect(links[0]?.disconnected).toBe(true);
	});

	it("出た後に届いた文字起こしは渡さない", async () => {
		const transcription = Promise.withResolvers<Transcription>();
		const { service, links, accepted } = setup({ transcribe: () => transcription.promise });
		await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
		links[0]?.handlers.onUtterance("42", new Float32Array(1_000));

		await service.leave();
		transcription.resolve({ text: "ねえルナ", elapsedMs: 80 });
		await flush();

		expect(accepted).toEqual([]);
	});
});
