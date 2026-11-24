import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { Models } from "@earendil-works/pi-ai";
import type { Client } from "discord.js";

import { PiModelStreams } from "../modules/agent/adapters/outbound/pi/pi-model-stream";
import { fetchUsage } from "../modules/agent/adapters/outbound/pi/usage";
import { UsagePoller } from "../modules/agent/adapters/outbound/pi/usage-poller";
import type { ModelSelection } from "../modules/agent/ports/outbound/agent-session-port";
import { ChildProcessCheckRunner } from "../modules/automation/adapters/child-process-check-runner";
import { ChokidarScheduleWatcher } from "../modules/automation/adapters/chokidar-schedule-watcher";
import { CronScheduleTimer } from "../modules/automation/adapters/cron-schedule-timer";
import {
	randomIntegerInclusive,
	SystemAutomationClock,
} from "../modules/automation/adapters/system-clock";
import { AutomationService } from "../modules/automation/application/automation-service";
import { HeartbeatController } from "../modules/automation/application/heartbeat-controller";
import { MemoryMaintenanceController } from "../modules/automation/application/memory-maintenance-controller";
import { RetentionCleaner } from "../modules/automation/application/retention-cleaner";
import { ScheduleController } from "../modules/automation/application/schedule-controller";
import type { AutomationWorkspacePort } from "../modules/automation/ports/automation-workspace-port";
import { ConversationCoordinator } from "../modules/conversation/application/conversation-coordinator";
import type { AcceptedConversationEvent } from "../modules/conversation/domain/conversation-session";
import { startDashboardServer } from "../modules/dashboard/adapters/dashboard-server";
import { DashboardService } from "../modules/dashboard/application/dashboard-service";
import { DiscordActionAdapter } from "../modules/discord/adapters/discord-action-adapter";
import {
	createDiscordCommandClient,
	DiscordCommandAdapter,
} from "../modules/discord/adapters/discord-command-adapter";
import { DiscordConversationController } from "../modules/discord/adapters/discord-conversation-controller";
import { DiscordConversationDelegation } from "../modules/discord/adapters/discord-conversation-delegation";
import { DiscordConversationHistory } from "../modules/discord/adapters/discord-conversation-history";
import {
	createDiscordGatewayClient,
	DiscordGatewayAdapter,
} from "../modules/discord/adapters/discord-gateway-adapter";
import {
	createDiscordReadClient,
	DiscordReadAdapter,
} from "../modules/discord/adapters/discord-read-adapter";
import {
	createDiscordReadToolProvider,
	createDiscordToolProvider,
} from "../modules/discord/adapters/discord-tool-provider";
import { resolveSendFile } from "../modules/discord/adapters/filesystem-send-file-resolver";
import { TypingLeaseRegistry } from "../modules/discord/application/typing-lease-registry";
import {
	createDiscordConversationSession,
	isDiscordConversationSession,
	isDiscordGuildSession,
} from "../modules/discord/domain/discord-event";
import { discordIdSchema } from "../modules/discord/domain/discord-id";
import { EventExecutor } from "../modules/event/application/event-executor";
import { registerAssistRoute } from "../modules/home-assistant/adapters/assist-route";
import { createAssistToolProvider } from "../modules/home-assistant/adapters/assist-tool-provider";
import {
	createNodeHomeAssistantSocket,
	HomeAssistantConnection,
} from "../modules/home-assistant/adapters/home-assistant-connection";
import { HomeAssistantRegistry } from "../modules/home-assistant/adapters/home-assistant-registry";
import { HomeAssistantRestClient } from "../modules/home-assistant/adapters/home-assistant-rest-client";
import { createHomeAssistantToolProvider } from "../modules/home-assistant/adapters/home-assistant-tool-provider";
import { WatchConfigFile } from "../modules/home-assistant/adapters/watch-config-file";
import { AssistResponseRegistry } from "../modules/home-assistant/application/assist-response-registry";
import { AssistService } from "../modules/home-assistant/application/assist-service";
import { StateChangeWatcher } from "../modules/home-assistant/application/state-change-watcher";
import {
	HOME_ASSISTANT_EVENT_SOURCE,
	ASSIST_REQUESTED_EVENT_TYPE,
} from "../modules/home-assistant/domain/home-assistant-event";
import {
	HOME_ASSISTANT_TOOL_INSTRUCTIONS,
	HOME_ASSISTANT_WATCH_INSTRUCTIONS,
} from "../modules/home-assistant/home-assistant-instructions";
import { startHttpEventServer } from "../modules/http/adapters/http-event-server";
import { createHttpResponseToolProvider } from "../modules/http/adapters/http-response-tool-provider";
import { HttpEventService } from "../modules/http/application/http-event-service";
import { HttpResponseRegistry } from "../modules/http/application/http-response-registry";
import { HTTP_EVENT_SOURCE } from "../modules/http/domain/http-event";
import { IntentFileStore } from "../modules/intent/adapters/intent-file-store";
import { IntentMatcher } from "../modules/intent/application/intent-matcher";
import { JsonWorldMemoryStore } from "../modules/minecraft/adapters/json-world-memory-store";
import { createMinecraftToolProvider } from "../modules/minecraft/adapters/minecraft-tool-provider";
import {
	createMineflayerConnector,
	spawnMineflayerWorker,
} from "../modules/minecraft/adapters/mineflayer-connection";
import { PiDecisionModel } from "../modules/minecraft/adapters/pi-decision-model";
import { MinecraftPlayService } from "../modules/minecraft/application/minecraft-play-service";
import { MINECRAFT_WORKER_INSTRUCTIONS } from "../modules/minecraft/minecraft-instructions";
import { createPinoLogger } from "../modules/observability/adapters/pino-logger";
import { RecentLogBuffer } from "../modules/observability/adapters/recent-log-buffer";
import type { LoggerPort } from "../modules/observability/ports/logger-port";
import { JsonFileTaskStore } from "../modules/task/adapters/json-file-task-store";
import {
	createTaskBoardToolProvider,
	createTaskReportToolProvider,
} from "../modules/task/adapters/task-tool-provider";
import { TaskService } from "../modules/task/application/task-service";
import type { WorkerCatalog } from "../modules/task/domain/task";
import { createWaitToolProvider } from "../modules/tool/adapters/wait-tool-provider";
import { createToolSet } from "../modules/tool/application/tool-set";
import { AivisSpeechSynthesizer } from "../modules/voice/adapters/aivis-speech-synthesizer";
import { DiscordVoiceGateway } from "../modules/voice/adapters/discord-voice-gateway";
import { PiInterruptClassifier } from "../modules/voice/adapters/pi-interrupt-classifier";
import { SherpaTranscriber } from "../modules/voice/adapters/sherpa-transcriber";
import { createSpeechDetector } from "../modules/voice/adapters/silero-vad";
import { SpeechClippingTranscriber } from "../modules/voice/adapters/speech-clipping-transcriber";
import { SpeechCppSynthesizer } from "../modules/voice/adapters/speech-cpp-synthesizer";
import { createVoiceToolProvider } from "../modules/voice/adapters/voice-tool-provider";
import { VoiceChannelService } from "../modules/voice/application/voice-channel-service";
import { DELEGATE_TOOL, VoiceResponder } from "../modules/voice/application/voice-responder";
import {
	VOICE_DELEGATED_EVENT_TYPE,
	VOICE_TRANSCRIPT_EVENT_TYPE,
	VOICE_UTTERANCE_EVENT_TYPE,
} from "../modules/voice/domain/voice-event";
import type { SpeechSynthesizerPort } from "../modules/voice/ports/speech-port";
import { voiceFrontInstructions } from "../modules/voice/voice-front-instructions";
import { VOICE_INSTRUCTIONS } from "../modules/voice/voice-instructions";
import { AllowedChannelSettings } from "../modules/workspace/adapters/allowed-channel-settings";
import { initializeWorkspace } from "../modules/workspace/adapters/initialize-workspace";
import {
	readWorkspaceSchedule,
	removeWorkspaceScheduleJob,
} from "../modules/workspace/adapters/schedule-toml";
import { SkillUsageStore } from "../modules/workspace/adapters/skill-usage-store";
import { readWorkspaceSkillsPrompt } from "../modules/workspace/adapters/workspace-skills";
import {
	TRASH_RETENTION_DAYS,
	WorkspaceTrash,
} from "../modules/workspace/adapters/workspace-trash";
import {
	readHeartbeatContext,
	readWorkspaceBaseInstructions,
} from "../modules/workspace/application/workspace-instructions";
import { MINECRAFT_WORKER_NAME } from "../modules/workspace/domain/workspace-config";
import type {
	MinecraftSetting,
	TtsSetting,
	VoiceSetting,
} from "../modules/workspace/domain/workspace-config";
import {
	createChatGptBackend,
	createAgentModels,
	modelSelectionsOf,
	createPiAgentRuntime,
	validateModelSelections,
	workerCatalogOf,
} from "./agent-runtime";
import { readRuntimeEnvironment } from "./runtime-environment";
import { buildSystemPrompt, createSessionFactory } from "./session-factory";
import type { SessionProfile } from "./session-factory";
import { SESSION_DEVELOPER_INSTRUCTIONS } from "./session-instructions";

const TYPING_REFRESH_INTERVAL_MS = 8_000;
const SCHEDULE_RELOAD_DEBOUNCE_MS = 250;
const SCHEDULE_CHECK_TIMEOUT_MS = 120_000;
const SCHEDULE_CHECK_KILL_GRACE_MS = 5_000;
const RECENT_LOG_CAPACITY = 500;
const TRASH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RECENT_LOG_MAX_FIELD_LENGTH = 4_000;
const USAGE_POLL_INTERVAL_MS = 600_000;
const VOICE_EMPTY_JOIN_WAIT_MS = 60_000;
// 声の返事は待てないので、会話のリクエストより短く打ち切る。
const VOICE_FRONT_TIMEOUT_MS = 30_000;
// 判定を待つ間もルナは小さな声で話し続ける。これを超えたら割り込みとして扱う。
const VOICE_INTERRUPT_TIMEOUT_MS = 3_000;
// 1文の合成。別のホストのTTSが落ちている時に、返事を長く止めないため。
const VOICE_TTS_TIMEOUT_MS = 15_000;

interface LunaApplication {
	shutdown(): Promise<void>;
}

export async function startLunaApplication(
	options: Readonly<{ startupSignal?: AbortSignal; templatesDir: string }>,
): Promise<LunaApplication> {
	options.startupSignal?.throwIfAborted();
	const startedAt = new Date();
	const environment = readRuntimeEnvironment(process.env);
	const workspace = await initializeWorkspace({
		lunaHome: environment.lunaHome,
		templatesDir: options.templatesDir,
	});
	const allowedChannels = new AllowedChannelSettings(
		workspace.configPath,
		workspace.config.discord.allowedChannelIds,
	);
	const recentLogs = new RecentLogBuffer({
		capacity: RECENT_LOG_CAPACITY,
		maxFieldLength: RECENT_LOG_MAX_FIELD_LENGTH,
		now: () => new Date(),
	});
	const logger = createPinoLogger({
		level: environment.logLevel,
		onEntry: (entry) => recentLogs.record(entry),
	});
	const client = createDiscordGatewayClient({ voice: workspace.config.voice !== undefined });
	const typing = new TypingLeaseRegistry(TYPING_REFRESH_INTERVAL_MS, (error, context) => {
		logger.error("discord.typing.refresh_failed", { error, ...context });
	});
	const actionAdapter = new DiscordActionAdapter(client, resolveSendFile, typing);
	let conversation: ConversationCoordinator | undefined;
	const delegation = new DiscordConversationDelegation(client, {
		accept: (input) => conversation?.accept(input) ?? false,
		allowDm: workspace.config.discord.allowDm,
		createId: randomUUID,
		now: () => new Date(),
	});
	const httpResponses = new HttpResponseRegistry();
	const assistResponses = new AssistResponseRegistry();
	const homeAssistant =
		environment.homeAssistant === undefined
			? undefined
			: createHomeAssistant({
					...environment.homeAssistant,
					accept: (input) => conversation?.accept(input) ?? false,
					logger,
					watchConfigPath: resolve(workspace.workspaceDir, "home-assistant.toml"),
				});
	let tasks: TaskService | undefined;
	const taskBoard = {
		cancel: async (...input: Parameters<TaskService["cancel"]>) =>
			await requireTasks(tasks).cancel(...input),
		create: async (...input: Parameters<TaskService["create"]>) =>
			await requireTasks(tasks).create(...input),
		message: async (...input: Parameters<TaskService["message"]>) =>
			await requireTasks(tasks).message(...input),
		report: async (...input: Parameters<TaskService["report"]>) =>
			await requireTasks(tasks).report(...input),
	};
	const models = createAgentModels(workspace.lunaHomeDir);
	const voice =
		workspace.config.voice === undefined
			? undefined
			: await createVoice({
					setting: workspace.config.voice,
					model: workspace.config.models.voice,
					models,
					workspaceDir: workspace.workspaceDir,
					client,
					accept: (input) => conversation?.accept(input) ?? false,
					logger,
				});
	const minecraftSetting = workspace.config.minecraft;
	const minecraft =
		minecraftSetting === undefined
			? undefined
			: await createMinecraft({
					setting: minecraftSetting,
					lunaHomeDir: workspace.lunaHomeDir,
					workspaceDir: workspace.workspaceDir,
					logger,
				});
	const generalWorkers = workerCatalogOf(workspace.config.models.worker);
	const workerCatalog: WorkerCatalog =
		minecraftSetting === undefined
			? generalWorkers
			: {
					...generalWorkers,
					choices: [
						...generalWorkers.choices,
						{
							name: MINECRAFT_WORKER_NAME,
							description: minecraftSetting.planner.description,
							model: {
								provider: minecraftSetting.planner.provider,
								model: minecraftSetting.planner.model,
								thinking: minecraftSetting.planner.thinking,
							},
							exclusive: true,
						},
					],
				};
	const readAdapter = new DiscordReadAdapter(createDiscordReadClient(client));
	const discordHistory = new DiscordConversationHistory(readAdapter);
	const waitTools = createWaitToolProvider();
	const tools = createToolSet(
		[
			createDiscordToolProvider({ actions: actionAdapter, delegation, read: readAdapter }),
			createHttpResponseToolProvider(httpResponses),
			createAssistToolProvider(assistResponses),
			createTaskBoardToolProvider(taskBoard, workerCatalog),
			waitTools,
			...(homeAssistant === undefined ? [] : [homeAssistant.tools]),
			...(voice === undefined ? [] : [createVoiceToolProvider(voice)]),
		],
		logger,
	);
	const workerProviders = [
		createDiscordReadToolProvider(readAdapter),
		createTaskReportToolProvider(taskBoard),
		waitTools,
		...(homeAssistant === undefined ? [] : [homeAssistant.tools]),
	];
	const workerTools = createToolSet(workerProviders, logger);
	const minecraftTools =
		minecraft === undefined
			? undefined
			: createToolSet([...workerProviders, createMinecraftToolProvider(minecraft)], logger);
	const releaseTools = async (ownerId: string): Promise<void> => {
		await Promise.all([
			tools.release(ownerId),
			workerTools.release(ownerId),
			minecraftTools?.release(ownerId),
		]);
	};
	const backend = createChatGptBackend(models);
	const agent = createPiAgentRuntime({
		backend,
		compactionModel: workspace.config.models.compaction,
		lunaHomeDir: workspace.lunaHomeDir,
		logger,
		models,
		parentEnvironment: process.env,
		requestTimeoutMs: workspace.config.agent.requestTimeoutMs,
		skillUsage: new SkillUsageStore(resolve(workspace.lunaHomeDir, "state", "skill-usage.json")),
	});
	validateModelSelections(agent, {
		...modelSelectionsOf(workspace.config.models),
		...(minecraftSetting === undefined ? {} : { minecraft: minecraftSetting.planner }),
	});
	const usage = new UsagePoller({
		fetch: async (signal) => await fetchUsage(backend, signal),
		filePath: resolve(workspace.lunaHomeDir, "state", "usage.json"),
		intervalMs: USAGE_POLL_INTERVAL_MS,
		logger,
		onUsage: (snapshot) => agent.setUsage(snapshot),
	});
	const withHomeAssistant = (
		instructions: readonly string[],
		homeAssistantInstructions: readonly string[],
	): readonly string[] =>
		homeAssistant === undefined ? instructions : [...instructions, ...homeAssistantInstructions];
	const homeAssistantInstructions = [
		HOME_ASSISTANT_TOOL_INSTRUCTIONS,
		HOME_ASSISTANT_WATCH_INSTRUCTIONS,
	];
	const generalWorkerProfile: SessionProfile = {
		developerInstructions: withHomeAssistant(SESSION_DEVELOPER_INSTRUCTIONS.worker, [
			HOME_ASSISTANT_TOOL_INSTRUCTIONS,
		]),
		includeWorkspaceInstructions: false,
		model: undefined,
		tools: workerTools,
	};
	const minecraftProfile: SessionProfile | undefined =
		minecraftTools === undefined
			? undefined
			: {
					...generalWorkerProfile,
					developerInstructions: [
						...generalWorkerProfile.developerInstructions,
						MINECRAFT_WORKER_INSTRUCTIONS,
					],
					tools: minecraftTools,
				};
	const openSession = createSessionFactory({
		agent,
		fastMode: (origin) =>
			origin.kind === "conversation" && (voice?.isBound(origin.session.key) ?? false),
		profiles: {
			conversation: {
				developerInstructions: withHomeAssistant(
					voice === undefined
						? SESSION_DEVELOPER_INSTRUCTIONS.conversation
						: [...SESSION_DEVELOPER_INSTRUCTIONS.conversation, VOICE_INSTRUCTIONS],
					homeAssistantInstructions,
				),
				includeWorkspaceInstructions: true,
				model: () => workspace.config.models.conversation,
				tools,
			},
			event: {
				developerInstructions: withHomeAssistant(
					SESSION_DEVELOPER_INSTRUCTIONS.event,
					homeAssistantInstructions,
				),
				includeWorkspaceInstructions: true,
				model: () => workspace.config.models.event,
				tools,
			},
			worker: (name) =>
				name === MINECRAFT_WORKER_NAME && minecraftProfile !== undefined
					? minecraftProfile
					: generalWorkerProfile,
		},
		readSkillsPrompt: () => readWorkspaceSkillsPrompt(workspace.workspaceDir),
		workspaceDir: workspace.workspaceDir,
	});

	const startupCleanups: Array<() => Promise<void> | void> = [
		() => httpResponses.failAll(),
		() => assistResponses.failAll(),
		() => homeAssistant?.connection.stop(),
		() => typing.releaseAll(),
		async () => await voice?.stop(),
		async () => await minecraft?.stop(),
		async () => await client.destroy(),
		async () => await usage.stop(),
	];
	// abort時は待機中の起動処理を解くだけにする。ここで全て閉じるとabort後に生成されたリソースが漏れ、
	// catchで再実行するとHTTPサーバーを二重closeするため、後始末はcatchで1回だけ行う。
	const abortStartup = () => {
		void Promise.allSettled([client.destroy()]).then((results) => {
			logCleanupFailures(results, logger, "application.startup_cleanup_failed");
		});
	};
	options.startupSignal?.addEventListener("abort", abortStartup, { once: true });
	try {
		options.startupSignal?.throwIfAborted();
		usage.start();
		await client.login(environment.discordBotToken);
		options.startupSignal?.throwIfAborted();
		const lunaUserId = discordIdSchema.parse(client.user?.id);
		const taskService = new TaskService({
			createId: randomUUID,
			delivery: {
				deliver: (origin, event) => {
					if (origin.kind === "conversation") {
						return Promise.resolve(
							coordinator.accept({ session: origin.session, event }) ? "accepted" : "rejected",
						);
					}
					// 実行を始めた時点で配送済みとし、失敗しても外部作用の重複を避けて再配送しない。
					return executor.execute(event).then(() => "accepted");
				},
			},
			isPrivateSession: (session) => !isDiscordGuildSession(session),
			logger,
			maxConcurrent: workspace.config.tasks.maxConcurrent,
			now: () => new Date(),
			openSession,
			releaseTools,
			store: new JsonFileTaskStore(workspace.tasksDir, (path, error) => {
				logger.error("task.file_invalid", { error, path });
			}),
			workers: workerCatalog,
		});
		tasks = taskService;
		const intentMatcher = new IntentMatcher(
			new IntentFileStore(
				resolve(workspace.workspaceDir, "intents.toml"),
				resolve(workspace.lunaHomeDir, "state", "intents-state.json"),
			),
			logger,
			() => new Date(),
		);
		const coordinator = new ConversationCoordinator(
			{
				intents: intentMatcher,
				history: {
					fetchBefore: async (session, beforeEvent, limit) => {
						if (session.source === HTTP_EVENT_SOURCE) return [];
						if (session.source === HOME_ASSISTANT_EVENT_SOURCE) return [];
						return await discordHistory.fetchBefore(session, beforeEvent, limit);
					},
				},
				logger,
				now: () => new Date(),
				onBatchSettled: (eventIds, succeeded) => {
					for (const eventId of eventIds) {
						httpResponses.complete(eventId, succeeded);
						assistResponses.complete(eventId, succeeded);
					}
					voice?.onBatchSettled(eventIds);
				},
				openSession,
				releaseTools,
				tasks: {
					listFor: (session) =>
						taskService.listFor({ kind: "conversation", sessionKey: session.key }),
				},
			},
			{
				debounceMs: workspace.config.discord.debounceMs,
				isImmediate: (event) =>
					event.type === ASSIST_REQUESTED_EVENT_TYPE || VOICE_EVENT_TYPES.has(event.type),
				initialHistoryLimit: workspace.config.discord.initialHistoryLimit,
				sessionMemoryEnabled: workspace.config.memory.enabled,
				sessionIdleMs: workspace.config.discord.sessionIdleMs,
				typingIdleMs: workspace.config.discord.typingIdleMs,
			},
		);
		conversation = coordinator;

		const clock = new SystemAutomationClock();
		const trash = new WorkspaceTrash(workspace.workspaceDir, logger);
		const executor = new EventExecutor({
			logger,
			now: () => new Date(),
			openSession,
			releaseTools,
			tasks: { listAll: () => taskService.listFor({ kind: "event" }) },
		});
		const automationWorkspace: AutomationWorkspacePort = {
			readHeartbeatContext: async () => await readHeartbeatContext(workspace.workspaceDir),
			readSchedule: async () => await readWorkspaceSchedule(workspace.cronPath),
			removeScheduleJob: (jobId) => {
				removeWorkspaceScheduleJob(workspace.cronPath, jobId);
			},
		};
		const httpService = new HttpEventService({
			conversation: coordinator,
			executor,
			responses: httpResponses,
		});
		startupCleanups.push(() => httpService.stopIntake());
		const assistService = new AssistService({
			conversation: coordinator,
			createId: randomUUID,
			now: () => new Date(),
			responses: assistResponses,
		});
		startupCleanups.push(() => assistService.stopIntake());
		if (homeAssistant !== undefined) {
			startupCleanups.push(() => homeAssistant.watcher.stopIntake());
		}
		const scheduleTimer = new CronScheduleTimer();
		const automation = new AutomationService({
			heartbeat: new HeartbeatController({
				clock,
				enabled: workspace.config.heartbeat.enabled,
				executor,
				logger,
				nextDelayMs: () =>
					randomIntegerInclusive(
						workspace.config.heartbeat.minIntervalMs,
						workspace.config.heartbeat.maxIntervalMs,
					),
				workspace: automationWorkspace,
			}),
			memoryMaintenance: new MemoryMaintenanceController({
				clock,
				cron: workspace.config.memory.maintenanceCron,
				enabled: workspace.config.memory.enabled,
				executor,
				scheduleTimer,
			}),
			cleaners: [
				...(workspace.config.agent.transcriptCleanupEnabled
					? [
							new RetentionCleaner({
								cleanupIntervalMs: workspace.config.agent.transcriptCleanupIntervalMs,
								clock,
								failureEvent: "automation.transcript_retention.prune_failed",
								logger,
								pruner: {
									prune: async (now, retentionMs) => {
										await agent.pruneTranscripts(now, retentionMs);
									},
								},
								retentionMs: workspace.config.agent.transcriptRetentionMs,
							}),
						]
					: []),
				new RetentionCleaner({
					cleanupIntervalMs: TRASH_CLEANUP_INTERVAL_MS,
					clock,
					failureEvent: "workspace.trash.prune_failed",
					logger,
					pruner: { prune: async (now) => await trash.prune(now) },
					retentionMs: TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
				}),
			],
			schedule: new ScheduleController({
				checkRunner: new ChildProcessCheckRunner({
					cwd: workspace.workspaceDir,
					killGraceMs: SCHEDULE_CHECK_KILL_GRACE_MS,
					parentEnvironment: process.env,
					timeoutMs: SCHEDULE_CHECK_TIMEOUT_MS,
				}),
				clock,
				executor,
				logger,
				reloadDebounceMs: SCHEDULE_RELOAD_DEBOUNCE_MS,
				scheduleTimer,
				watcher: new ChokidarScheduleWatcher(workspace.cronPath),
				workspace: automationWorkspace,
			}),
		});
		startupCleanups.push(
			async () => await automation.stopIntake(),
			() => taskService.stopIntake(),
		);
		await taskService.start();
		await automation.startAutomation(workspace.schedule);
		options.startupSignal?.throwIfAborted();

		const gatewayController = new DiscordConversationController(coordinator, lunaUserId, {
			allowDm: workspace.config.discord.allowDm,
			allowedChannelIds: allowedChannels.ids,
			createId: randomUUID,
			now: () => new Date(),
			isVoiceBound: (sessionKey) => voice?.isBound(sessionKey) ?? false,
			onAccepted: (event) => {
				logger
					.child({
						conversationScope: JSON.stringify(event.scope),
						conversationSession: createDiscordConversationSession(event.scope).key,
					})
					.info(
						"conversation.message_accepted",
						{ authorId: event.message.author.id, messageId: event.message.id },
						event.message,
					);
			},
			onError: (error, event) => {
				logger.error("discord.gateway_event_failed", { error, event });
			},
		});
		const commands = new DiscordCommandAdapter(
			createDiscordCommandClient(client),
			coordinator,
			agent,
			workspace.config.discord.allowDm,
			allowedChannels,
			(error) => logger.error("discord.command_failed", { error }),
		);
		startupCleanups.push(() => commands.stop());
		await commands.start();
		const gateway = new DiscordGatewayAdapter(client, gatewayController);
		startupCleanups.push(() => gateway.stop());
		gateway.start();
		const httpServer = await startHttpEventServer({
			hostname: environment.httpHost,
			port: environment.httpPort,
			service: httpService,
			onError: (error) => logger.error("http.server_failed", { error }),
			configure: (app) => registerAssistRoute(app, assistService),
		});
		startupCleanups.push(async () => await httpServer.close());
		const dashboardServer = await startDashboardServer({
			dashboard: new DashboardService({
				now: () => new Date(),
				sources: {
					activity: () => recentLogs.list(),
					agent: () => agent.status(),
					homeAssistant: () => homeAssistant?.watcher.status() ?? null,
					minecraft: () => minecraft?.snapshot() ?? null,
					automation: () => automation.snapshot(),
					workspace: () => trash.status(),
					conversations: () => coordinator.snapshot(),
					events: () => executor.snapshot(),
					tasks: () => taskService.snapshot(),
				},
				startedAt,
			}),
			hostname: environment.dashboardHost,
			port: environment.dashboardPort,
			onError: (error) => logger.error("dashboard.server_failed", { error }),
		});
		startupCleanups.push(async () => await dashboardServer.close());
		homeAssistant?.connection.start();
		options.startupSignal?.throwIfAborted();
		logger.info("application.started");
		let shutdownPromise: Promise<void> | undefined;

		const application = {
			shutdown: async () => {
				shutdownPromise ??= shutdownApplication({
					automation,
					clientDestroy: async () => await client.destroy(),
					conversation: coordinator,
					dashboardClose: () => dashboardServer.close(),
					events: executor,
					gateway: {
						stop: () => {
							gateway.stop();
							commands.stop();
						},
					},
					homeAssistant: {
						stopIntake: () => {
							assistService.stopIntake();
							homeAssistant?.watcher.stopIntake();
						},
						failPending: () => assistResponses.failAll(),
						stop: () => homeAssistant?.connection.stop(),
					},
					http: httpService,
					httpClose: () => httpServer.close(),
					httpFailPending: () => httpResponses.failAll(),
					logger,
					tasks: taskService,
					typingRelease: () => typing.releaseAll(),
					usageStop: () => usage.stop(),
					voiceStop: async () => await voice?.stop(),
					minecraftStop: async () => await minecraft?.stop(),
				});
				await shutdownPromise;
			},
		};
		options.startupSignal?.removeEventListener("abort", abortStartup);
		return application;
	} catch (error: unknown) {
		options.startupSignal?.removeEventListener("abort", abortStartup);
		const cleanupResults = await Promise.allSettled(startupCleanups.map(runCleanup));
		logCleanupFailures(cleanupResults, logger, "application.startup_cleanup_failed");
		throw error;
	}
}

export async function shutdownApplication(input: {
	automation: Pick<AutomationService, "drain" | "stopIntake">;
	clientDestroy(): Promise<void>;
	conversation: Pick<ConversationCoordinator, "drain" | "stopIntake">;
	dashboardClose(): Promise<void>;
	events: Pick<EventExecutor, "stopActivities">;
	gateway: Pick<DiscordGatewayAdapter, "stop">;
	homeAssistant: Readonly<{ stopIntake(): void; failPending(): void; stop(): void }>;
	http: Pick<HttpEventService, "stopIntake" | "drain">;
	httpClose(): Promise<void>;
	httpFailPending(): void;
	logger: LoggerPort & Readonly<{ flush(): Promise<void> }>;
	minecraftStop(): Promise<void>;
	tasks: Pick<TaskService, "drain" | "stopIntake">;
	typingRelease(): void;
	usageStop(): Promise<void>;
	voiceStop(): Promise<void>;
}): Promise<void> {
	input.logger.info("application.shutdown_started");
	const failures: unknown[] = [];
	await settleCleanup(
		[
			runCleanup(() => input.gateway.stop()),
			runCleanup(() => input.conversation.stopIntake()),
			runCleanup(() => input.http.stopIntake()),
			runCleanup(() => input.homeAssistant.stopIntake()),
			runCleanup(() => input.tasks.stopIntake()),
			input.automation.stopIntake(),
			input.events.stopActivities(),
			input.voiceStop(),
		],
		failures,
	);
	await settleCleanup(
		[input.conversation.drain(), input.automation.drain(), input.http.drain(), input.tasks.drain()],
		failures,
	);
	await settleCleanup(
		[
			runCleanup(() => input.httpFailPending()),
			runCleanup(() => input.homeAssistant.failPending()),
			runCleanup(() => input.homeAssistant.stop()),
			input.httpClose(),
			input.dashboardClose(),
			// タスクのセッションを閉じるとプレイも終わるが、ワーカーが残らないよう直接も止める。
			input.minecraftStop(),
			runCleanup(() => input.typingRelease()),
			input.usageStop(),
			input.clientDestroy(),
		],
		failures,
	);
	for (const error of failures) {
		input.logger.error("application.shutdown_cleanup_failed", { error });
	}
	input.logger.info("application.shutdown_completed");
	await input.logger.flush().catch((error: unknown) => failures.push(error));
	if (failures.length > 0) throw new AggregateError(failures, "Application shutdown failed");
}

async function runCleanup(cleanup: () => void | Promise<void>): Promise<void> {
	await cleanup();
}

async function settleCleanup(
	promises: readonly Promise<void>[],
	failures: unknown[],
): Promise<void> {
	const results = await Promise.allSettled(promises);
	for (const result of results) {
		if (result.status === "rejected") failures.push(result.reason);
	}
}

function logCleanupFailures(
	results: readonly PromiseSettledResult<void>[],
	logger: LoggerPort,
	event: string,
): void {
	for (const result of results) {
		if (result.status === "rejected") logger.error(event, { error: result.reason });
	}
}

function requireTasks(tasks: TaskService | undefined): TaskService {
	if (tasks === undefined) throw new Error("Task service is not ready");
	return tasks;
}

function createSynthesizer(setting: TtsSetting): SpeechSynthesizerPort {
	if (setting.engine === "voicevox") {
		return new AivisSpeechSynthesizer(setting.url, setting.speaker, setting.speed);
	}
	return new SpeechCppSynthesizer({
		baseUrl: setting.url,
		voice: setting.voice,
		speed: setting.speed,
		timeoutMs: VOICE_TTS_TIMEOUT_MS,
	});
}

// 声の集約を待たずに渡す音声の入力。
const VOICE_EVENT_TYPES: ReadonlySet<string> = new Set([
	VOICE_UTTERANCE_EVENT_TYPE,
	VOICE_DELEGATED_EVENT_TYPE,
	VOICE_TRANSCRIPT_EVENT_TYPE,
]);

async function createMinecraft(
	input: Readonly<{
		setting: MinecraftSetting;
		lunaHomeDir: string;
		workspaceDir: string;
		logger: LoggerPort;
	}>,
): Promise<MinecraftPlayService> {
	const { setting } = input;
	const decisions = await PiDecisionModel.create({
		...setting.decisionModel,
		timeoutMs: setting.decisionTimeoutMs,
		fetch: globalThis.fetch,
	});
	return new MinecraftPlayService({
		connect: createMineflayerConnector(
			{
				host: setting.host,
				port: setting.port,
				username: setting.username,
				actionsDir: resolve(input.workspaceDir, "minecraft", "actions"),
			},
			spawnMineflayerWorker,
		),
		decisions,
		memory: new JsonWorldMemoryStore(
			resolve(input.lunaHomeDir, "minecraft", setting.world, "memory.json"),
		),
		logger: input.logger,
		now: () => new Date(),
		schedule: (callback, milliseconds) => {
			const timer = setTimeout(callback, milliseconds);
			return () => clearTimeout(timer);
		},
		settings: {
			world: setting.world,
			decisionTimeoutMs: setting.decisionTimeoutMs,
			plannerIntervalMs: setting.plannerIntervalMs,
		},
	});
}

async function createVoice(
	input: Readonly<{
		setting: VoiceSetting;
		model: ModelSelection;
		models: Models;
		workspaceDir: string;
		client: Client;
		accept(input: AcceptedConversationEvent): boolean;
		logger: LoggerPort;
	}>,
): Promise<VoiceChannelService> {
	const { setting, logger } = input;
	const classifier = await PiInterruptClassifier.create({
		...setting.interruptModel,
		timeoutMs: VOICE_INTERRUPT_TIMEOUT_MS,
		fetch: globalThis.fetch,
	});
	const modelStreams = new PiModelStreams({
		models: input.models,
		requestTimeoutMs: VOICE_FRONT_TIMEOUT_MS,
	});
	const transcriber = SpeechClippingTranscriber.create(
		setting.vadModel,
		await SherpaTranscriber.create({
			kind: setting.sttModelKind,
			modelDir: setting.sttModelDir,
			numThreads: setting.sttThreads,
		}),
	);
	return new VoiceChannelService({
		gateway: new DiscordVoiceGateway(input.client, {
			silenceMs: setting.silenceMs,
			createDetector: () => createSpeechDetector(setting.vadModel),
			logger,
			now: () => performance.now(),
		}),
		transcriber,
		synthesizer: createSynthesizer(setting.tts),
		classifier,
		openResponder: async () => {
			const instructions = await readWorkspaceBaseInstructions(input.workspaceDir);
			const stream = modelStreams.open({
				model: input.model,
				systemPrompt: buildSystemPrompt({
					developerInstructions: [
						voiceFrontInstructions({
							emoji: setting.tts.engine === "speech-cpp" && setting.tts.emoji,
						}),
					],
					skills: "",
					luna: instructions.luna,
					memory: instructions.memory,
				}),
				tools: [DELEGATE_TOOL],
			});
			return new VoiceResponder(stream, logger);
		},
		conversation: { accept: input.accept },
		isVoiceSession: isDiscordConversationSession,
		createId: randomUUID,
		now: () => new Date(),
		monotonic: () => performance.now(),
		logger,
		emptyJoinWaitMs: VOICE_EMPTY_JOIN_WAIT_MS,
		turn: {
			silenceMs: setting.silenceMs,
			turnWaitMs: setting.turnWaitMs,
			unfinishedTurnWaitMs: setting.unfinishedTurnWaitMs,
		},
	});
}

function createHomeAssistant(
	input: Readonly<{
		url: URL;
		token: string;
		accept(input: AcceptedConversationEvent): boolean;
		logger: LoggerPort;
		watchConfigPath: string;
	}>,
) {
	const clock = new SystemAutomationClock();
	let watcher: StateChangeWatcher | undefined;
	const connection = new HomeAssistantConnection({
		url: input.url,
		token: input.token,
		createSocket: createNodeHomeAssistantSocket,
		logger: input.logger,
		now: () => clock.now(),
		setTimer: (delayMs, callback) => clock.setTimer(delayMs, callback),
		onStateChanged: (change) => watcher?.handle(change),
	});
	watcher = new StateChangeWatcher({
		config: new WatchConfigFile(input.watchConfigPath, input.logger),
		conversation: { accept: input.accept },
		connectionStatus: () => connection.status(),
		createId: randomUUID,
		logger: input.logger,
		now: () => clock.now(),
	});
	const tools = createHomeAssistantToolProvider({
		rest: new HomeAssistantRestClient({ baseUrl: input.url, token: input.token, fetch }),
		registry: new HomeAssistantRegistry({ connection, now: () => clock.now() }),
	});
	return { connection, tools, watcher };
}
