import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AcceptedConversationEvent,
	ConversationSession,
} from "../../conversation/domain/conversation-session";
import { createRecordingLogger } from "../../observability/testing/recording-logger";
import type { ToolOrigin } from "../../tool/domain/tool";
import type { VoiceChannelRef } from "../domain/voice-event";
import type { InterruptClassifierPort } from "../ports/interrupt-classifier-port";
import type { VoiceLink, VoiceLinkHandlers } from "../ports/voice-gateway-port";
import {
	createFakeFront,
	createFakePlayback,
	createFakeVoices,
	flush,
	textSynthesizer,
} from "../testing/fake-voice";
import type { FakePlayback } from "../testing/fake-voice";
import { VoiceChannelService } from "./voice-channel-service";
import { VoiceResponder } from "./voice-responder";

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
const NOW = "2026-11-15T00:00:00.000Z";
const TURN_WAIT_MS = 800;

type FakeLink = VoiceLink &
	FakePlayback & {
		handlers: VoiceLinkHandlers;
		muted: boolean[];
		disconnected: boolean;
		humans: number;
	};

function setup(
	options: {
		humans?: number;
		accept?: (input: AcceptedConversationEvent) => boolean;
	} = {},
) {
	vi.useFakeTimers();
	const links: FakeLink[] = [];
	const accepted: AcceptedConversationEvent[] = [];
	const logger = createRecordingLogger();
	const voices = createFakeVoices();
	const front = createFakeFront();
	const classifier = {
		classify: vi.fn<InterruptClassifierPort["classify"]>(async () => "interruption"),
	};
	const openResponder = vi.fn(async () => new VoiceResponder(front.stream, logger));
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
					...createFakePlayback(),
					handlers,
					muted: [connectOptions.muted],
					disconnected: false,
					humans: options.humans ?? 1,
					get humanCount() {
						return this.humans;
					},
					ongoingSpeech: () => undefined,
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
		transcriber: voices.transcriber,
		synthesizer: textSynthesizer,
		classifier,
		openResponder,
		conversation: {
			accept: (input) => {
				accepted.push(input);
				return options.accept?.(input) ?? true;
			},
		},
		isVoiceSession: (session) => session.source === "discord/main",
		createId: () => `event-${String(++ids)}`,
		now: () => new Date(NOW),
		monotonic: () => Date.now(),
		logger,
		emptyJoinWaitMs: 60_000,
		turn: { silenceMs: 500, turnWaitMs: TURN_WAIT_MS, unfinishedTurnWaitMs: 2000 },
	});

	const link = (): FakeLink => {
		const found = links.at(-1);
		if (found === undefined) throw new Error("not connected");
		return found;
	};
	// 声を検知してから区切れ、続きがなくターンが確定するまで。
	const speak = async (text: string, userId = "42"): Promise<void> => {
		link().handlers.onSpeechStarted(userId);
		link().handlers.onSegment(userId, voices.voice(text));
		await flush();
	};
	const commitTurn = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);
		await flush();
	};
	const frontCall = (index: number) => {
		const found = front.calls[index];
		if (found === undefined) throw new Error(`front was not asked ${String(index + 1)} times`);
		return found;
	};
	const types = () => accepted.map((input) => input.event.type);
	const events = () => logger.entries.map((entry) => entry.event);
	return {
		service,
		links,
		link,
		accepted,
		logger,
		voices,
		front,
		openResponder,
		speak,
		commitTurn,
		frontCall,
		types,
		events,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("VoiceChannelService", () => {
	describe("参加と紐づけ", () => {
		it("呼んだ会話にVCを紐づけ、テキストモードでは確定した発話を voice_utterance としてその会話へ渡す", async () => {
			const { service, speak, accepted, openResponder } = setup();

			await expect(
				service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION)),
			).resolves.toEqual({ channel: VC, mode: "text" });
			expect(service.isBound(TEXT_SESSION.key)).toBe(true);
			await speak("ねえルナ");
			await vi.advanceTimersByTimeAsync(TURN_WAIT_MS - 1);
			expect(accepted).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);

			expect(accepted).toEqual([
				{
					session: TEXT_SESSION,
					event: {
						id: "event-1",
						type: "discord.voice.utterance.v1",
						source: "discord/voice",
						subject: TEXT_SESSION.key,
						occurredAt: NOW,
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
			expect(openResponder).not.toHaveBeenCalled();
		});

		it("確定を待つ間に同じ人が話し始めたら、続きとつなげて1つの発話として渡す", async () => {
			const { service, link, voices, speak, commitTurn, accepted } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
			await speak("ねえルナ");

			link().handlers.onSpeechStarted("42");
			await vi.advanceTimersByTimeAsync(5_000);
			expect(accepted).toEqual([]);
			link().handlers.onSegment("42", voices.voice("明日晴れる？"));
			await commitTurn();

			expect(accepted.map((input) => input.event.data)).toEqual([
				expect.objectContaining({ text: "ねえルナ明日晴れる？" }),
			]);
		});

		it("声以外の音しか聞き取れなかった区切りは渡さない", async () => {
			const { service, link, voices, commitTurn, accepted } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			link().handlers.onSegment("42", voices.voice("", { nonVerbal: true }));
			await commitTurn();

			expect(accepted).toEqual([]);
		});

		it("文字起こしに失敗したらログに残し、何も渡さない", async () => {
			const { service, voices, speak, commitTurn, accepted, events } = setup();
			voices.transcriber.transcribe.mockRejectedValueOnce(new Error("decoder crashed"));
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			await speak("ねえルナ");
			await commitTurn();

			expect(accepted).toEqual([]);
			expect(events()).toContain("voice.segment.failed");
		});

		it("表示名を取れない話者はユーザーIDを speaker にする", async () => {
			const { service, speak, commitTurn, accepted } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			await speak("ねえルナ", "unknown");
			await commitTurn();

			expect(accepted[0]?.event.data).toMatchObject({ speaker: "unknown", user_id: "unknown" });
		});

		it("会話が発話を受け付けなかったらログに残す", async () => {
			const { service, speak, commitTurn, logger } = setup({ accept: () => false });
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			await speak("ねえルナ");
			await commitTurn();

			expect(logger.entries).toContainEqual(
				expect.objectContaining({
					level: "warn",
					event: "voice.utterance.rejected",
					details: { userId: "42", eventId: "event-1" },
				}),
			);
		});

		it("同じVCへの voice_join は入り直さず、紐づけ先だけを切り替える", async () => {
			const { service, links, speak, commitTurn, accepted } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			await service.join({ target: { channelId: "500" }, mode: "text" }, from(OTHER_SESSION));
			await speak("ねえルナ");
			await commitTurn();

			expect(links).toHaveLength(1);
			expect(service.isBound(TEXT_SESSION.key)).toBe(false);
			expect(service.isBound(OTHER_SESSION.key)).toBe(true);
			expect(accepted.map((input) => input.session)).toEqual([OTHER_SESSION]);
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

		it("音声モードで入る時に表を開けなければ、参加は失敗してVCから出る", async () => {
			const { service, links, openResponder } = setup();
			openResponder.mockRejectedValueOnce(new Error("LUNA.md is unreadable"));

			await expect(
				service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION)),
			).rejects.toThrow("LUNA.md is unreadable");

			expect(links[0]?.disconnected).toBe(true);
			expect(service.isBound(TEXT_SESSION.key)).toBe(false);
		});
	});

	describe("モードとミュート", () => {
		it("テキストモードではミュートで入り、モードを切り替えるとミュートも切り替える", async () => {
			const { service, links, openResponder } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			expect(links[0]?.muted).toEqual([true, false, true]);
			expect(openResponder).toHaveBeenCalledTimes(1);
		});

		it("音声モードではミュートせずに入る", async () => {
			const { service, links } = setup();

			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));

			expect(links[0]?.muted).toEqual([false]);
		});

		it("テキストモードから音声モードへ切り替える時に表を開けなければ、テキストモードのまま失敗する", async () => {
			const { service, links, openResponder, speak, commitTurn, accepted } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
			openResponder.mockRejectedValueOnce(new Error("LUNA.md is unreadable"));

			await expect(
				service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION)),
			).rejects.toThrow("LUNA.md is unreadable");
			await speak("ねえルナ");
			await commitTurn();

			expect(links[0]?.muted).toEqual([true]);
			expect(accepted.map((input) => input.event.data)).toEqual([
				expect.objectContaining({ mode: "text" }),
			]);
		});

		it("別の会話からの切り替えに失敗したら、紐づけ先も元の会話のまま", async () => {
			const { service, openResponder } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
			openResponder.mockRejectedValueOnce(new Error("LUNA.md is unreadable"));

			await expect(
				service.join({ target: { channelId: "500" }, mode: "voice" }, from(OTHER_SESSION)),
			).rejects.toThrow("LUNA.md is unreadable");

			expect(service.isBound(TEXT_SESSION.key)).toBe(true);
			expect(service.isBound(OTHER_SESSION.key)).toBe(false);
		});
	});

	describe("音声モードの会話", () => {
		it("確定した発話は会話へ渡さず、先行生成した表の返事をターンの確定後に再生する", async () => {
			const { service, link, speak, commitTurn, frontCall, accepted } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));

			await speak("ねえルナ");
			expect(frontCall(0).recordLines()).toEqual([expect.stringMatching(/ シュン: ねえルナ$/u)]);
			frontCall(0).say("やっほー。");
			frontCall(0).end();
			await flush();
			expect(link().plays).toEqual([]);
			await commitTurn();

			expect(link().plays.map((play) => play.text)).toEqual(["やっほー。"]);
			expect(accepted).toEqual([]);
		});

		it("表が出した依頼を、まだ渡していない会話記録と一緒に delegated イベントで会話へ渡す", async () => {
			const { service, speak, commitTurn, frontCall, accepted, events } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("明日の天気わかる？");
			frontCall(0).say("調べるね。");
			frontCall(0).delegate("明日の東京の天気");
			await commitTurn();

			expect(accepted).toEqual([
				{
					session: TEXT_SESSION,
					event: {
						id: "event-1",
						type: "discord.voice.delegated.v1",
						source: "discord/voice",
						subject: TEXT_SESSION.key,
						occurredAt: NOW,
						data: {
							guild_id: "1",
							channel_id: "500",
							request: "明日の東京の天気",
							transcript: [
								{
									at: NOW,
									type: "heard",
									user_id: "42",
									speaker: "シュン",
									text: "明日の天気わかる？",
								},
							],
						},
					},
				},
			]);
			expect(events()).toContain("voice.delegated");
		});

		it("依頼を渡した実行が終わるまでは確定した発話も voice_utterance として渡し、終わったら渡さない", async () => {
			const { service, link, speak, commitTurn, frontCall, accepted, types } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("明日の天気わかる？");
			frontCall(0).say("調べるね。");
			frontCall(0).delegate("明日の東京の天気");
			frontCall(0).end();
			await commitTurn();
			link().finishPlaying();
			await flush();

			await speak("傘がいるかも知りたい");
			await commitTurn();
			service.onBatchSettled(["unrelated-event"]);
			await speak("あと気温も");
			await commitTurn();
			service.onBatchSettled(["event-1"]);
			await speak("ありがとう");
			await commitTurn();

			expect(types()).toEqual([
				"discord.voice.delegated.v1",
				"discord.voice.utterance.v1",
				"discord.voice.utterance.v1",
			]);
			expect(accepted[1]?.event.data).toEqual({
				guild_id: "1",
				channel_id: "500",
				user_id: "42",
				speaker: "シュン",
				text: "傘がいるかも知りたい",
				mode: "voice",
			});
		});

		it("会話が依頼を受け付けなかったらログに残し、発話の受け渡しも始めない", async () => {
			const { service, speak, commitTurn, frontCall, types, logger } = setup({
				accept: (input) => input.event.type !== "discord.voice.delegated.v1",
			});
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("明日の天気わかる？");
			frontCall(0).delegate("明日の東京の天気");
			frontCall(0).end();
			await commitTurn();

			await speak("傘もいるかな");
			await commitTurn();

			expect(types()).toEqual(["discord.voice.delegated.v1"]);
			expect(logger.entries).toContainEqual(
				expect.objectContaining({
					level: "warn",
					event: "voice.delegation.rejected",
					details: { eventId: "event-1" },
				}),
			);
		});

		it("受け付けられなかった依頼の会話記録は、退出時の transcript で渡し直す", async () => {
			const { service, speak, commitTurn, frontCall, accepted } = setup({
				accept: (input) => input.event.type !== "discord.voice.delegated.v1",
			});
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("明日の天気わかる？");
			frontCall(0).delegate("明日の東京の天気");
			frontCall(0).end();
			await commitTurn();

			await service.leave();

			expect(accepted.at(-1)?.event.data).toMatchObject({
				transcript: [
					expect.objectContaining({ type: "heard", text: "明日の天気わかる？" }),
					expect.objectContaining({ type: "delegated", request: "明日の東京の天気" }),
				],
			});
		});

		it("voice_report の結果を、誰も話していない時に表に伝えさせる", async () => {
			const { service, frontCall, link } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));

			service.report("明日の東京は晴れ", from(TEXT_SESSION));
			await flush();
			frontCall(0).say("明日は晴れだって。");
			frontCall(0).end();
			await flush();

			expect(frontCall(0).recordLines()).toEqual([
				expect.stringMatching(/ Backstage report: 明日の東京は晴れ$/u),
			]);
			expect(link().plays.map((play) => play.text)).toEqual(["明日は晴れだって。"]);
		});

		it("voice_report は音声モードで紐づいた会話から呼んだ時だけ受け付ける", async () => {
			const { service, front } = setup();
			expect(() => service.report("晴れ", from(TEXT_SESSION))).toThrow(
				"voice_report works only while Luna is in a voice channel in voice mode.",
			);
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
			expect(() => service.report("晴れ", from(TEXT_SESSION))).toThrow(
				"voice_report works only while Luna is in a voice channel in voice mode.",
			);
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			expect(() => service.report("晴れ", from(OTHER_SESSION))).toThrow(
				"voice_report works only from the conversation the voice channel is bound to.",
			);
			expect(() =>
				service.report("晴れ", {
					kind: "event",
					eventId: "e1",
					eventType: "system.heartbeat.fired.v1",
				}),
			).toThrow("voice_report works only from the conversation the voice channel is bound to.");
			await flush();

			expect(front.calls).toEqual([]);
		});
	});

	describe("音声モードの終わり", () => {
		it("音声モードで出る時、裏へまだ渡していない会話記録を transcript イベントで渡す", async () => {
			const { service, link, speak, commitTurn, frontCall, accepted, front } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("ねえルナ");
			frontCall(0).say("やっほー。");
			frontCall(0).end();
			await commitTurn();
			link().finishPlaying();
			await flush();

			await service.leave();

			expect(accepted).toEqual([
				{
					session: TEXT_SESSION,
					event: {
						id: "event-1",
						type: "discord.voice.transcript.v1",
						source: "discord/voice",
						subject: TEXT_SESSION.key,
						occurredAt: NOW,
						data: {
							guild_id: "1",
							channel_id: "500",
							transcript: [
								{ at: NOW, type: "heard", user_id: "42", speaker: "シュン", text: "ねえルナ" },
								{ at: NOW, type: "said", played: ["やっほー。"], cut: null, dropped: [] },
							],
						},
					},
				},
			]);
			expect(front.closed()).toBe(true);
			expect(link().disconnected).toBe(true);
		});

		it("依頼で渡した会話記録は、出る時の transcript に重ねて入れない", async () => {
			const { service, link, speak, commitTurn, frontCall, accepted, types } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("明日の天気わかる？");
			frontCall(0).say("調べるね。");
			frontCall(0).delegate("明日の東京の天気");
			frontCall(0).end();
			await commitTurn();
			link().finishPlaying();
			await flush();

			await service.leave();

			expect(types()).toEqual(["discord.voice.delegated.v1", "discord.voice.transcript.v1"]);
			expect(accepted[1]?.event.data).toMatchObject({
				transcript: [{ type: "said", played: ["調べるね。"] }],
			});
		});

		it("音声モードからテキストモードに切り替えたら読み上げを止め、transcript を渡し、以後の発話はそのまま渡す", async () => {
			const { service, link, speak, commitTurn, frontCall, accepted, types } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("昔話をお願い");
			frontCall(0).say("昔々。あるところに");
			await commitTurn();
			const playing = link().plays[0]?.done.promise;

			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
			await speak("やっぱりいいや");
			await commitTurn();

			await expect(playing).resolves.toBe(false);
			expect(frontCall(0).signal.aborted).toBe(true);
			expect(types()).toEqual(["discord.voice.transcript.v1", "discord.voice.utterance.v1"]);
			expect(accepted[0]?.event.data).toMatchObject({
				transcript: [
					{ type: "heard", text: "昔話をお願い" },
					{ type: "said", played: [], cut: "昔々。", dropped: [] },
				],
			});
			expect(accepted[1]?.event.data).toMatchObject({ text: "やっぱりいいや", mode: "text" });
		});

		it("音声モードで誰も話さないまま出たら、transcript を渡さない", async () => {
			const { service, accepted } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));

			await service.leave();

			expect(accepted).toEqual([]);
		});

		it("会話が transcript を受け付けなかったらログに残して出る", async () => {
			const { service, link, speak, commitTurn, frontCall, logger } = setup({
				accept: () => false,
			});
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));
			await speak("ねえルナ");
			frontCall(0).end();
			await commitTurn();

			await service.leave();

			expect(link().disconnected).toBe(true);
			expect(logger.entries).toContainEqual(
				expect.objectContaining({
					level: "warn",
					event: "voice.transcript.rejected",
					details: { eventId: "event-1" },
				}),
			);
		});
	});

	describe("退出", () => {
		it("voice_leave で出て、入っていなければ失敗する", async () => {
			const { service, links } = setup();
			await expect(service.leave()).rejects.toThrow("Not in a voice channel.");
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			await expect(service.leave()).resolves.toEqual({ channel: VC });

			expect(links[0]?.disconnected).toBe(true);
			expect(service.isBound(TEXT_SESSION.key)).toBe(false);
		});

		it("いた人が全員抜けたら、すぐに出る", async () => {
			const { service, links } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			links[0]?.handlers.onHumanCount(0);
			await flush();

			expect(links[0]?.disconnected).toBe(true);
			expect(service.isBound(TEXT_SESSION.key)).toBe(false);
		});

		it("誰もいないVCに入ったら人が来るのを60秒待ち、来なければ出る", async () => {
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

		it("Discord側でつながりが切れたら、入っていない状態に戻る", async () => {
			const { service, links } = setup();
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));

			links[0]?.handlers.onClosed();
			await flush();

			expect(service.isBound(TEXT_SESSION.key)).toBe(false);
		});

		it("止めるとVCから出て、表も閉じる", async () => {
			const { service, links, front } = setup();
			await service.join({ target: { channelId: "500" }, mode: "voice" }, from(TEXT_SESSION));

			await service.stop();

			expect(links[0]?.disconnected).toBe(true);
			expect(front.closed()).toBe(true);
		});

		it("出た後に届いた文字起こしは渡さない", async () => {
			const { service, voices, speak, accepted } = setup();
			let transcribed: (() => void) | undefined;
			voices.transcriber.transcribe.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						transcribed = () => resolve({ text: "ねえルナ", nonVerbal: false, elapsedMs: 80 });
					}),
			);
			await service.join({ target: { channelId: "500" }, mode: "text" }, from(TEXT_SESSION));
			await speak("ねえルナ");

			await service.leave();
			transcribed?.();
			await vi.advanceTimersByTimeAsync(TURN_WAIT_MS);

			expect(accepted).toEqual([]);
		});
	});
});
