import { randomUUID } from "node:crypto";

import { AgentRuntimeSupervisor } from "../modules/agent/adapters/outbound/codex/agent-runtime-supervisor";
import { CodexAgentRuntime } from "../modules/agent/adapters/outbound/codex/codex-agent-runtime";
import { startCodexStdioProcess } from "../modules/agent/adapters/outbound/codex/codex-stdio-process";
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
import { ThreadRetentionCleaner } from "../modules/automation/application/thread-retention-cleaner";
import type { AutomationWorkspacePort } from "../modules/automation/ports/automation-workspace-port";
import { ConversationCoordinator } from "../modules/conversation/application/conversation-coordinator";
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
	DISCORD_MCP_TYPING_OWNER_HEADER,
	startDiscordMcpServer,
} from "../modules/discord/adapters/discord-mcp-server";
import {
	createDiscordReadClient,
	DiscordReadAdapter,
} from "../modules/discord/adapters/discord-read-adapter";
import { resolveSendFile } from "../modules/discord/adapters/filesystem-send-file-resolver";
import { TypingLeaseRegistry } from "../modules/discord/application/typing-lease-registry";
import { DISCORD_CAPABILITY_INSTRUCTIONS } from "../modules/discord/discord-capability-instructions";
import { isDiscordGuildSession } from "../modules/discord/domain/discord-event";
import { discordIdSchema } from "../modules/discord/domain/discord-id";
import { createWaitEffectProvider } from "../modules/effect/adapters/wait-effect-provider";
import { createEffectOutputContract } from "../modules/effect/application/effect-output-contract";
import { createEffectRegistry } from "../modules/effect/application/effect-registry";
import { createEffectBatchExecutor } from "../modules/effect/application/execute-effect-batch";
import { EventExecutor } from "../modules/event/application/event-executor";
import { startHttpEventServer } from "../modules/http/adapters/http-event-server";
import { HttpEventService } from "../modules/http/application/http-event-service";
import { HttpResponseRegistry } from "../modules/http/application/http-response-registry";
import { HTTP_EVENT_SOURCE } from "../modules/http/domain/http-event";
import { JsonLinesLogger } from "../modules/observability/adapters/json-lines-logger";
import { JsonFileTaskStore } from "../modules/task/adapters/json-file-task-store";
import {
	createTaskBoardEffectProvider,
	createTaskReportEffectProvider,
} from "../modules/task/adapters/task-effect-provider";
import { TaskService } from "../modules/task/application/task-service";
import {
	TASK_BOARD_INSTRUCTIONS,
	TASK_WORKER_INSTRUCTIONS,
} from "../modules/task/task-instructions";
import { AllowedChannelSettings } from "../modules/workspace/adapters/allowed-channel-settings";
import { initializeWorkspace } from "../modules/workspace/adapters/initialize-workspace";
import {
	readWorkspaceSchedule,
	removeWorkspaceScheduleJob,
} from "../modules/workspace/adapters/schedule-toml";
import { readHeartbeatChecklist } from "../modules/workspace/application/workspace-instructions";
import { LUNA_DEVELOPER_INSTRUCTIONS } from "./developer-instructions";
import { createEffectProviders } from "./effect-providers";
import { readRuntimeEnvironment } from "./runtime-environment";
import { createThreadInputFactory } from "./thread-input-factory";

const TYPING_REFRESH_INTERVAL_MS = 8_000;
const SCHEDULE_RELOAD_DEBOUNCE_MS = 250;
const SCHEDULE_CHECK_TIMEOUT_MS = 120_000;
const SCHEDULE_CHECK_KILL_GRACE_MS = 5_000;

interface LunaApplication {
	fatal: Promise<Error>;
	shutdown(fatal?: boolean): Promise<void>;
}

export async function startLunaApplication(
	options: Readonly<{ startupSignal?: AbortSignal }> = {},
): Promise<LunaApplication> {
	options.startupSignal?.throwIfAborted();
	const environment = readRuntimeEnvironment(process.env);
	const workspace = await initializeWorkspace({ lunaHome: environment.lunaHome });
	const allowedChannels = new AllowedChannelSettings(
		workspace.configPath,
		workspace.config.discord.allowedChannelIds,
	);
	const logger = new JsonLinesLogger(environment.logLevel);
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
	const effectRegistry = createEffectRegistry([
		...createEffectProviders({ actions: actionAdapter, delegation, httpResponses }),
		createTaskBoardEffectProvider(taskBoard),
	]);
	const effectOutput = createEffectOutputContract(effectRegistry);
	const effects = createEffectBatchExecutor(effectRegistry, logger);
	const workerEffectRegistry = createEffectRegistry([
		createTaskReportEffectProvider(taskBoard),
		createWaitEffectProvider(),
	]);
	const workerEffectOutput = createEffectOutputContract(workerEffectRegistry);
	const workerEffects = createEffectBatchExecutor(workerEffectRegistry, logger);
	const readAdapter = new DiscordReadAdapter(createDiscordReadClient(client));
	const discordHistory = new DiscordConversationHistory(readAdapter);
	const mcp = await startDiscordMcpServer({
		actions: actionAdapter,
		onError: (error) => logger.log("error", "discord.mcp_transport_failed", {}, { error }),
		onEvent: (event, context, details, payload) => {
			logger.log("info", event, context, details, payload);
		},
		read: readAdapter,
	});

	let eventExecutor: EventExecutor | undefined;
	const fatal = Promise.withResolvers<Error>();
	const supervisor = new AgentRuntimeSupervisor(
		{
			initialDelayMs: workspace.config.agent.restartInitialDelayMs,
			limit: workspace.config.agent.restartFailureLimit,
			maxDelayMs: workspace.config.agent.restartMaxDelayMs,
			windowMs: workspace.config.agent.restartWindowMs,
		},
		{
			onFailure: (error) => {
				logger.log("error", "agent.connection_failed", {}, { error });
				conversation?.connectionLost(error);
				eventExecutor?.connectionLost();
				tasks?.connectionLost();
			},
			onFatal: (error) => {
				logger.log("error", "agent.restart_budget_exceeded", {}, { error });
				fatal.resolve(error);
			},
			startRuntime: async (signal, onFailure) =>
				await CodexAgentRuntime.start({
					onFailure,
					onRpcEvent: (event, context, details, payload) => {
						logger.log("info", event, context, details, payload);
					},
					openTransport: (handlers) =>
						startCodexStdioProcess(
							{ codexHomeDir: workspace.codexHomeDir, cwd: workspace.workspaceDir },
							handlers,
						),
					rpcTimeoutMs: workspace.config.agent.rpcTimeoutMs,
					signal,
				}),
		},
	);

	const startupCleanups: Array<() => Promise<void> | void> = [
		() => httpResponses.failAll(),
		() => typing.releaseAll(),
		async () => await client.destroy(),
		async () => await supervisor.close(),
		async () => await mcp.close(),
	];
	// abort時は待機中の起動処理を解くだけにする。ここで全て閉じるとabort後に生成されたリソースが漏れ、
	// catchで再実行するとHTTP/MCPサーバーを二重closeするため、後始末はcatchで1回だけ行う。
	const abortStartup = () => {
		void Promise.allSettled([client.destroy(), supervisor.close()]).then((results) => {
			logCleanupFailures(results, logger, "application.startup_cleanup_failed");
		});
	};
	options.startupSignal?.addEventListener("abort", abortStartup, { once: true });
	try {
		options.startupSignal?.throwIfAborted();
		await supervisor.start();
		options.startupSignal?.throwIfAborted();
		await client.login(environment.discordBotToken);
		options.startupSignal?.throwIfAborted();
		const lunaUserId = discordIdSchema.parse(client.user?.id);
		const createThreadInput = createThreadInputFactory({
			buildMcpServers: (executionOwnerId) => ({
				discord: {
					url: mcp.url,
					http_headers: { [DISCORD_MCP_TYPING_OWNER_HEADER]: executionOwnerId },
				},
			}),
			developerInstructions: [
				LUNA_DEVELOPER_INSTRUCTIONS,
				DISCORD_CAPABILITY_INSTRUCTIONS,
				TASK_BOARD_INSTRUCTIONS,
			],
			workspaceDir: workspace.workspaceDir,
		});
		const createWorkerThreadInput = createThreadInputFactory({
			buildMcpServers: () => ({ discord: { url: mcp.readOnlyUrl } }),
			developerInstructions: [TASK_WORKER_INSTRUCTIONS],
			workspaceDir: workspace.workspaceDir,
		});
		const taskService = new TaskService({
			agent: supervisor,
			createId: randomUUID,
			createThreadInput: createWorkerThreadInput,
			delivery: {
				deliver: (origin, event) => {
					if (origin.kind === "conversation") {
						return Promise.resolve(
							coordinator.accept({ session: origin.session, event }) ? "accepted" : "rejected",
						);
					}
					void executor.execute(event);
					return Promise.resolve("accepted");
				},
			},
			effectOutput: workerEffectOutput,
			effects: workerEffects,
			isPrivateSession: (session) => !isDiscordGuildSession(session),
			logger,
			maxConcurrent: workspace.config.tasks.maxConcurrent,
			now: () => new Date(),
			store: new JsonFileTaskStore(workspace.tasksDir, (path, error) => {
				logger.log("error", "task.file_invalid", {}, { error, path });
			}),
		});
		tasks = taskService;
		const coordinator = new ConversationCoordinator(
			{
				agent: supervisor,
				createThreadInput,
				effectOutput,
				effects,
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
			agent: supervisor,
			createThreadInput,
			effectOutput,
			effects,
			logger,
			tasks: { listAll: () => taskService.listFor({ kind: "event" }) },
		});
		eventExecutor = executor;
		const automationWorkspace: AutomationWorkspacePort = {
			readHeartbeatChecklist: async () => await readHeartbeatChecklist(workspace.workspaceDir),
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
			retention: new ThreadRetentionCleaner({
				agent: supervisor,
				cleanupIntervalMs: workspace.config.agent.threadCleanupIntervalMs,
				clock,
				logger,
				retentionMs: workspace.config.agent.threadRetentionMs,
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
		startupCleanups.push(async () => await automation.stopIntake());
		await automation.startAutomation(workspace.schedule);
		startupCleanups.push(() => taskService.stopIntake());
		await taskService.start();
		options.startupSignal?.throwIfAborted();

		const gatewayController = new DiscordConversationController(coordinator, lunaUserId, {
			allowDm: workspace.config.discord.allowDm,
			allowedChannelIds: allowedChannels.ids,
			onAccepted: (event) => {
				logger.log(
					"info",
					"conversation.message_accepted",
					{ conversationScope: JSON.stringify(event.scope) },
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
			supervisor,
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
		options.startupSignal?.throwIfAborted();
		logger.log("info", "application.started");
		let shutdownPromise: Promise<void> | undefined;
		let fatalShutdownRequested = false;

		const application = {
			fatal: fatal.promise,
			shutdown: async (isFatal = false) => {
				if (shutdownPromise === undefined) {
					fatalShutdownRequested = isFatal;
					shutdownPromise = shutdownApplication({
						automation,
						clientDestroy: async () => await client.destroy(),
						conversation: coordinator,
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
						mcpClose: () => mcp.close(),
						supervisorClose: () => supervisor.close(),
						tasks: taskService,
						typingRelease: () => typing.releaseAll(),
						isFatal,
					});
				} else if (isFatal && !fatalShutdownRequested) {
					fatalShutdownRequested = true;
					await coordinator.abort();
				}
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
	conversation: Pick<ConversationCoordinator, "abort" | "drain" | "stopIntake">;
	gateway: Pick<DiscordGatewayAdapter, "stop">;
	http: Pick<HttpEventService, "stopIntake" | "drain">;
	httpClose(): Promise<void>;
	httpFailPending(): void;
	logger: Pick<JsonLinesLogger, "flush" | "log">;
	mcpClose(): Promise<void>;
	supervisorClose(): Promise<void>;
	tasks: Pick<TaskService, "drain" | "stopIntake">;
	typingRelease(): void;
	isFatal: boolean;
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
		[
			input.isFatal ? input.conversation.abort() : input.conversation.drain(),
			input.automation.drain(),
			input.http.drain(),
			input.tasks.drain(),
		],
		failures,
	);
	await settleCleanup(
		[
			runCleanup(() => input.httpFailPending()),
			input.httpClose(),
			runCleanup(() => input.typingRelease()),
			input.mcpClose(),
			input.clientDestroy(),
			input.supervisorClose(),
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
