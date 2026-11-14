import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { fetchUsage } from "../modules/agent/adapters/outbound/pi/usage";
import { UsagePoller } from "../modules/agent/adapters/outbound/pi/usage-poller";
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
import { ScheduleController } from "../modules/automation/application/schedule-controller";
import { TranscriptRetentionCleaner } from "../modules/automation/application/transcript-retention-cleaner";
import type { AutomationWorkspacePort } from "../modules/automation/ports/automation-workspace-port";
import { ConversationCoordinator } from "../modules/conversation/application/conversation-coordinator";
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
import { DISCORD_CAPABILITY_INSTRUCTIONS } from "../modules/discord/discord-capability-instructions";
import {
	createDiscordConversationSession,
	isDiscordGuildSession,
} from "../modules/discord/domain/discord-event";
import { discordIdSchema } from "../modules/discord/domain/discord-id";
import { EventExecutor } from "../modules/event/application/event-executor";
import { startHttpEventServer } from "../modules/http/adapters/http-event-server";
import { createHttpResponseToolProvider } from "../modules/http/adapters/http-response-tool-provider";
import { HttpEventService } from "../modules/http/application/http-event-service";
import { HttpResponseRegistry } from "../modules/http/application/http-response-registry";
import { HTTP_EVENT_SOURCE } from "../modules/http/domain/http-event";
import { JsonLinesLogger } from "../modules/observability/adapters/json-lines-logger";
import { RecentLogBuffer } from "../modules/observability/adapters/recent-log-buffer";
import type { LoggerPort } from "../modules/observability/ports/logger-port";
import { JsonFileTaskStore } from "../modules/task/adapters/json-file-task-store";
import {
	createTaskBoardToolProvider,
	createTaskReportToolProvider,
} from "../modules/task/adapters/task-tool-provider";
import { TaskService } from "../modules/task/application/task-service";
import {
	TASK_BOARD_INSTRUCTIONS,
	TASK_WORKER_INSTRUCTIONS,
} from "../modules/task/task-instructions";
import { createWaitToolProvider } from "../modules/tool/adapters/wait-tool-provider";
import { createToolSet } from "../modules/tool/application/tool-set";
import { AllowedChannelSettings } from "../modules/workspace/adapters/allowed-channel-settings";
import { initializeWorkspace } from "../modules/workspace/adapters/initialize-workspace";
import {
	readWorkspaceSchedule,
	removeWorkspaceScheduleJob,
} from "../modules/workspace/adapters/schedule-toml";
import { readWorkspaceSkillsPrompt } from "../modules/workspace/adapters/workspace-skills";
import { readHeartbeatContext } from "../modules/workspace/application/workspace-instructions";
import {
	createChatGptBackend,
	createAgentModels,
	createPiAgentRuntime,
	validateModelSelections,
} from "./agent-runtime";
import {
	EVENT_INSTRUCTIONS,
	LUNA_CONVERSATION_GUIDE,
	LUNA_CORE_INSTRUCTIONS,
	SESSION_END_INSTRUCTIONS,
} from "./developer-instructions";
import { readRuntimeEnvironment } from "./runtime-environment";
import { createSessionFactory } from "./session-factory";

const TYPING_REFRESH_INTERVAL_MS = 8_000;
const SCHEDULE_RELOAD_DEBOUNCE_MS = 250;
const SCHEDULE_CHECK_TIMEOUT_MS = 120_000;
const SCHEDULE_CHECK_KILL_GRACE_MS = 5_000;
const RECENT_LOG_CAPACITY = 500;
const RECENT_LOG_MAX_FIELD_LENGTH = 4_000;
const RECENT_LOG_EXCLUDED_EVENTS: ReadonlySet<string> = new Set();
const USAGE_POLL_INTERVAL_MS = 600_000;

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
	const stdoutLogger = new JsonLinesLogger(environment.logLevel);
	const recentLogs = new RecentLogBuffer({
		capacity: RECENT_LOG_CAPACITY,
		excludedEvents: RECENT_LOG_EXCLUDED_EVENTS,
		maxFieldLength: RECENT_LOG_MAX_FIELD_LENGTH,
		now: () => new Date(),
	});
	const logger = {
		flush: async () => await stdoutLogger.flush(),
		log: (...entry: Parameters<LoggerPort["log"]>) => {
			stdoutLogger.log(...entry);
			recentLogs.log(...entry);
		},
	};
	const client = createDiscordGatewayClient();
	const typing = new TypingLeaseRegistry(TYPING_REFRESH_INTERVAL_MS, (error, context) => {
		logger.log("error", "discord.typing.refresh_failed", {}, { error, ...context });
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
	const readAdapter = new DiscordReadAdapter(createDiscordReadClient(client));
	const discordHistory = new DiscordConversationHistory(readAdapter);
	const waitTools = createWaitToolProvider();
	const tools = createToolSet(
		[
			createDiscordToolProvider({ actions: actionAdapter, delegation, read: readAdapter }),
			createHttpResponseToolProvider(httpResponses),
			createTaskBoardToolProvider(taskBoard),
			waitTools,
		],
		logger,
	);
	const workerTools = createToolSet(
		[
			createDiscordReadToolProvider(readAdapter),
			createTaskReportToolProvider(taskBoard),
			waitTools,
		],
		logger,
	);
	const releaseTools = async (ownerId: string): Promise<void> => {
		await Promise.all([tools.release(ownerId), workerTools.release(ownerId)]);
	};
	const models = createAgentModels(workspace.lunaHomeDir);
	const backend = createChatGptBackend(models);
	const agent = createPiAgentRuntime({
		backend,
		compactionModel: workspace.config.models.compaction,
		lunaHomeDir: workspace.lunaHomeDir,
		logger,
		models,
		parentEnvironment: process.env,
		requestTimeoutMs: workspace.config.agent.requestTimeoutMs,
	});
	validateModelSelections(agent, workspace.config.models);
	const usage = new UsagePoller({
		fetch: async (signal) => await fetchUsage(backend, signal),
		filePath: resolve(workspace.lunaHomeDir, "state", "usage.json"),
		intervalMs: USAGE_POLL_INTERVAL_MS,
		logger,
		onUsage: (snapshot) => agent.setUsage(snapshot),
	});
	const openSession = createSessionFactory({
		agent,
		profiles: {
			conversation: {
				developerInstructions: [
					LUNA_CORE_INSTRUCTIONS,
					LUNA_CONVERSATION_GUIDE,
					SESSION_END_INSTRUCTIONS,
					DISCORD_CAPABILITY_INSTRUCTIONS,
					TASK_BOARD_INSTRUCTIONS,
				],
				includeWorkspaceInstructions: true,
				model: () => workspace.config.models.conversation,
				tools,
			},
			event: {
				developerInstructions: [
					LUNA_CORE_INSTRUCTIONS,
					LUNA_CONVERSATION_GUIDE,
					EVENT_INSTRUCTIONS,
					DISCORD_CAPABILITY_INSTRUCTIONS,
					TASK_BOARD_INSTRUCTIONS,
				],
				includeWorkspaceInstructions: true,
				model: () => workspace.config.models.event,
				tools,
			},
			worker: {
				developerInstructions: [TASK_WORKER_INSTRUCTIONS],
				includeWorkspaceInstructions: false,
				model: () => workspace.config.models.worker,
				tools: workerTools,
			},
		},
		readSkillsPrompt: () => readWorkspaceSkillsPrompt(workspace.workspaceDir),
		workspaceDir: workspace.workspaceDir,
	});

	const startupCleanups: Array<() => Promise<void> | void> = [
		() => httpResponses.failAll(),
		() => typing.releaseAll(),
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
				logger.log("error", "task.file_invalid", {}, { error, path });
			}),
		});
		tasks = taskService;
		const coordinator = new ConversationCoordinator(
			{
				history: {
					fetchBefore: async (session, beforeEvent, limit) => {
						if (session.source === HTTP_EVENT_SOURCE) return [];
						return await discordHistory.fetchBefore(session, beforeEvent, limit);
					},
				},
				logger,
				now: () => new Date(),
				onBatchSettled: (eventIds, succeeded) => {
					for (const eventId of eventIds) httpResponses.complete(eventId, succeeded);
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
				initialHistoryLimit: workspace.config.discord.initialHistoryLimit,
				sessionMemoryEnabled: workspace.config.memory.enabled,
				sessionIdleMs: workspace.config.discord.sessionIdleMs,
				typingIdleMs: workspace.config.discord.typingIdleMs,
			},
		);
		conversation = coordinator;

		const clock = new SystemAutomationClock();
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
			retention: new TranscriptRetentionCleaner({
				cleanupIntervalMs: workspace.config.agent.transcriptCleanupIntervalMs,
				clock,
				logger,
				pruner: {
					prune: async (now, retentionMs) => {
						await agent.pruneTranscripts(now, retentionMs);
					},
				},
				retentionMs: workspace.config.agent.transcriptRetentionMs,
			}),
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
			onAccepted: (event) => {
				logger.log(
					"info",
					"conversation.message_accepted",
					{
						conversationScope: JSON.stringify(event.scope),
						conversationSession: createDiscordConversationSession(event.scope).key,
					},
					{ authorId: event.message.author.id, messageId: event.message.id },
					event.message,
				);
			},
			onError: (error, event) => {
				logger.log("error", "discord.gateway_event_failed", {}, { error, event });
			},
		});
		const commands = new DiscordCommandAdapter(
			createDiscordCommandClient(client),
			coordinator,
			agent,
			workspace.config.discord.allowDm,
			allowedChannels,
			(error) => logger.log("error", "discord.command_failed", {}, { error }),
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
			onError: (error) => logger.log("error", "http.server_failed", {}, { error }),
		});
		startupCleanups.push(async () => await httpServer.close());
		const dashboardServer = await startDashboardServer({
			dashboard: new DashboardService({
				now: () => new Date(),
				sources: {
					activity: () => recentLogs.list(),
					agent: () => agent.status(),
					automation: () => automation.snapshot(),
					conversations: () => coordinator.snapshot(),
					events: () => executor.snapshot(),
					tasks: () => taskService.snapshot(),
				},
				startedAt,
			}),
			hostname: environment.dashboardHost,
			port: environment.dashboardPort,
			onError: (error) => logger.log("error", "dashboard.server_failed", {}, { error }),
		});
		startupCleanups.push(async () => await dashboardServer.close());
		options.startupSignal?.throwIfAborted();
		logger.log("info", "application.started");
		let shutdownPromise: Promise<void> | undefined;

		const application = {
			shutdown: async () => {
				shutdownPromise ??= shutdownApplication({
					automation,
					clientDestroy: async () => await client.destroy(),
					conversation: coordinator,
					dashboardClose: () => dashboardServer.close(),
					gateway: {
						stop: () => {
							gateway.stop();
							commands.stop();
						},
					},
					http: httpService,
					httpClose: () => httpServer.close(),
					httpFailPending: () => httpResponses.failAll(),
					logger,
					tasks: taskService,
					typingRelease: () => typing.releaseAll(),
					usageStop: () => usage.stop(),
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
	gateway: Pick<DiscordGatewayAdapter, "stop">;
	http: Pick<HttpEventService, "stopIntake" | "drain">;
	httpClose(): Promise<void>;
	httpFailPending(): void;
	logger: Pick<JsonLinesLogger, "flush" | "log">;
	tasks: Pick<TaskService, "drain" | "stopIntake">;
	typingRelease(): void;
	usageStop(): Promise<void>;
}): Promise<void> {
	input.logger.log("info", "application.shutdown_started");
	const failures: unknown[] = [];
	await settleCleanup(
		[
			runCleanup(() => input.gateway.stop()),
			runCleanup(() => input.conversation.stopIntake()),
			runCleanup(() => input.http.stopIntake()),
			runCleanup(() => input.tasks.stopIntake()),
			input.automation.stopIntake(),
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
			input.httpClose(),
			input.dashboardClose(),
			runCleanup(() => input.typingRelease()),
			input.usageStop(),
			input.clientDestroy(),
		],
		failures,
	);
	for (const error of failures) {
		input.logger.log("error", "application.shutdown_cleanup_failed", {}, { error });
	}
	input.logger.log("info", "application.shutdown_completed");
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
	logger: Pick<JsonLinesLogger, "log">,
	event: string,
): void {
	for (const result of results) {
		if (result.status === "rejected") logger.log("error", event, {}, { error: result.reason });
	}
}

function requireTasks(tasks: TaskService | undefined): TaskService {
	if (tasks === undefined) throw new Error("Task service is not ready");
	return tasks;
}
