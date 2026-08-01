import { AgentRuntimeSupervisor } from "../modules/agent/adapters/outbound/codex/agent-runtime-supervisor";
import { startManagedCodexRuntime } from "../modules/agent/adapters/outbound/codex/managed-codex-runtime";
import { AutomationAgentAdapter } from "../modules/automation/adapters/automation-agent-adapter";
import { ChokidarScheduleWatcher } from "../modules/automation/adapters/chokidar-schedule-watcher";
import { CronScheduleTimer } from "../modules/automation/adapters/cron-schedule-timer";
import {
  SystemAutomationClock,
  SystemAutomationRandom,
} from "../modules/automation/adapters/system-clock";
import { WorkspaceAutomationAdapter } from "../modules/automation/adapters/workspace-automation-adapter";
import { AutomationExecutor } from "../modules/automation/application/automation-executor";
import { AutomationService } from "../modules/automation/application/automation-service";
import { HeartbeatController } from "../modules/automation/application/heartbeat-controller";
import { MemoryMaintenanceController } from "../modules/automation/application/memory-maintenance-controller";
import { ScheduleController } from "../modules/automation/application/schedule-controller";
import { ThreadRetentionCleaner } from "../modules/automation/application/thread-retention-cleaner";
import type { AutomationLogPort } from "../modules/automation/ports/automation-log-port";
import { DiscordConversationController } from "../modules/conversation/adapters/discord-conversation-controller";
import { DiscordConversationHistory } from "../modules/conversation/adapters/discord-conversation-history";
import { ConversationCoordinator } from "../modules/conversation/application/conversation-coordinator";
import { DiscordActionAdapter } from "../modules/discord/adapters/discord-action-adapter";
import {
  createDiscordGatewayClient,
  createDiscordGatewayEventClient,
  DiscordGatewayAdapter,
} from "../modules/discord/adapters/discord-gateway-adapter";
import { startDiscordMcpServer } from "../modules/discord/adapters/discord-mcp-server";
import {
  createDiscordReadClient,
  DiscordReadAdapter,
} from "../modules/discord/adapters/discord-read-adapter";
import { FilesystemSendFileResolver } from "../modules/discord/adapters/filesystem-send-file-resolver";
import { createDiscordActionBatchPort } from "../modules/discord/application/execute-discord-actions";
import { TypingLeaseRegistry } from "../modules/discord/application/typing-lease-registry";
import { discordIdSchema } from "../modules/discord/domain/discord-id";
import { JsonLinesLogger } from "../modules/observability/adapters/json-lines-logger";
import { initializeWorkspace } from "../modules/workspace/adapters/initialize-workspace";

import { readRuntimeEnvironment } from "./runtime-environment";
import { createThreadInputFactory } from "./thread-input-factory";

const TYPING_REFRESH_INTERVAL_MS = 8_000;
const SCHEDULE_RELOAD_DEBOUNCE_MS = 250;

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
  const logger = new JsonLinesLogger(environment.logLevel);
  const client = createDiscordGatewayClient();
  const typing = new TypingLeaseRegistry(TYPING_REFRESH_INTERVAL_MS, (error, context) => {
    logger.log("error", "discord.typing.refresh_failed", {}, { error, ...context });
  });
  const actionAdapter = new DiscordActionAdapter(client, new FilesystemSendFileResolver(), typing);
  const actionBatch = createDiscordActionBatchPort(actionAdapter);
  const readAdapter = new DiscordReadAdapter(createDiscordReadClient(client));
  const mcp = await startDiscordMcpServer({
    actions: actionAdapter,
    onError: (error) => logger.log("error", "discord.mcp_transport_failed", {}, { error }),
    onEvent: (event, context, details, payload) => {
      logger.log("info", event, context, details, payload);
    },
    read: readAdapter,
  });

  let conversation: ConversationCoordinator | undefined;
  let automationAgent: AutomationAgentAdapter | undefined;
  const fatal = deferred<Error>();
  const supervisor = new AgentRuntimeSupervisor(
    {
      initialDelayMs: workspace.config.agent.restartInitialDelayMs,
      limit: workspace.config.agent.restartFailureLimit,
      maxDelayMs: workspace.config.agent.restartMaxDelayMs,
      windowMs: workspace.config.agent.restartWindowMs,
    },
    {
      startRuntime: async (signal) =>
        await startManagedCodexRuntime({
          codexHomeDir: workspace.codexHomeDir,
          cwd: workspace.workspaceDir,
          onRpcEvent: (event, context, details, payload) => {
            logger.log("info", event, context, details, payload);
          },
          rpcTimeoutMs: workspace.config.agent.rpcTimeoutMs,
          signal,
        }),
    },
  );
  supervisor.onFailure((error) => {
    logger.log("error", "agent.connection_failed", {}, { error });
    conversation?.connectionLost(error);
    automationAgent?.connectionLost();
  });
  supervisor.onFatal((error) => {
    logger.log("error", "agent.restart_budget_exceeded", {}, { error });
    fatal.resolve(error);
  });

  let automation: AutomationService | undefined;
  let gateway: DiscordGatewayAdapter | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const abortStartup = () => {
    void Promise.allSettled([
      runCleanup(() => gateway?.stop()),
      runCleanup(async () => await automation?.stopIntake()),
      runCleanup(() => typing.releaseAll()),
      client.destroy(),
      supervisor.close(),
      mcp.close(),
    ]);
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
      discordMcpServerUrl: mcp.url,
      workspaceDir: workspace.workspaceDir,
    });
    conversation = new ConversationCoordinator(
      {
        actions: actionBatch,
        agent: supervisor,
        createThreadInput,
        history: new DiscordConversationHistory(readAdapter),
        onError: (error, context) => {
          logger.log(
            "error",
            "conversation.operation_failed",
            { conversationScope: JSON.stringify(context.scope) },
            { error, operation: context.operation },
          );
        },
        onEvent: (event, context, details, payload) => {
          logger.log(
            "info",
            event,
            {
              ...(context.actionIndex === undefined ? {} : { actionIndex: context.actionIndex }),
              conversationScope: JSON.stringify(context.scope),
              ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
              ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
            },
            details,
            payload,
          );
        },
      },
      {
        debounceMs: workspace.config.discord.debounceMs,
        initialHistoryLimit: workspace.config.discord.initialHistoryLimit,
        sessionMemory: workspace.config.memory.enabled
          ? { enabled: true, now: () => new Date() }
          : { enabled: false },
        sessionIdleMs: workspace.config.discord.sessionIdleMs,
        typingIdleMs: workspace.config.discord.typingIdleMs,
      },
    );

    const automationLogger = createAutomationLogger(logger);
    const clock = new SystemAutomationClock();
    automationAgent = new AutomationAgentAdapter(
      supervisor,
      actionBatch,
      createThreadInput,
      (error, operation) => {
        logger.log("error", "automation.operation_failed", {}, { error, operation });
      },
    );
    const automationWorkspace = new WorkspaceAutomationAdapter({
      schedulePath: workspace.cronPath,
      workspaceDir: workspace.workspaceDir,
    });
    const executor = new AutomationExecutor({ agent: automationAgent, logger: automationLogger });
    const scheduleTimer = new CronScheduleTimer();
    automation = new AutomationService({
      heartbeat: new HeartbeatController({
        clock,
        enabled: workspace.config.heartbeat.enabled,
        executor,
        logger: automationLogger,
        maximumIntervalMs: workspace.config.heartbeat.maxIntervalMs,
        minimumIntervalMs: workspace.config.heartbeat.minIntervalMs,
        random: new SystemAutomationRandom(),
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
        agent: automationAgent,
        cleanupIntervalMs: workspace.config.agent.threadCleanupIntervalMs,
        clock,
        logger: automationLogger,
        retentionMs: workspace.config.agent.threadRetentionMs,
      }),
      schedule: new ScheduleController({
        clock,
        executor,
        logger: automationLogger,
        reloadDebounceMs: SCHEDULE_RELOAD_DEBOUNCE_MS,
        scheduleTimer,
        watcher: new ChokidarScheduleWatcher(workspace.cronPath),
        workspace: automationWorkspace,
      }),
    });
    await automation.startAutomation(workspace.schedule);
    options.startupSignal?.throwIfAborted();

    const gatewayController = new DiscordConversationController(conversation, lunaUserId, {
      allowDm: workspace.config.discord.allowDm,
      allowedChannelIds: workspace.config.discord.allowedChannelIds,
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
    gateway = new DiscordGatewayAdapter(createDiscordGatewayEventClient(client), gatewayController);
    gateway.start();
    options.startupSignal?.throwIfAborted();
    logger.log("info", "application.started");
    const runningAutomation = automation;
    const runningConversation = conversation;
    const runningGateway = gateway;
    let fatalShutdownRequested = false;

    const application = {
      fatal: fatal.promise,
      shutdown: async (isFatal = false) => {
        if (shutdownPromise === undefined) {
          fatalShutdownRequested = isFatal;
          shutdownPromise = shutdownApplication({
            automation: runningAutomation,
            clientDestroy: async () => await client.destroy(),
            conversation: runningConversation,
            gateway: runningGateway,
            logger,
            mcpClose: () => mcp.close(),
            supervisorClose: () => supervisor.close(),
            typingRelease: () => typing.releaseAll(),
            isFatal,
          });
        } else if (isFatal && !fatalShutdownRequested) {
          fatalShutdownRequested = true;
          await runningConversation.abort();
        }
        await shutdownPromise;
      },
    };
    options.startupSignal?.removeEventListener("abort", abortStartup);
    return application;
  } catch (error: unknown) {
    options.startupSignal?.removeEventListener("abort", abortStartup);
    const cleanupResults = await Promise.allSettled([
      runCleanup(() => gateway?.stop()),
      runCleanup(async () => await automation?.stopIntake()),
      runCleanup(() => typing.releaseAll()),
      client.destroy(),
      supervisor.close(),
      mcp.close(),
    ]);
    logCleanupFailures(cleanupResults, logger, "application.startup_cleanup_failed");
    throw error;
  }
}

export async function shutdownApplication(input: {
  automation: Pick<AutomationService, "drain" | "stopIntake">;
  clientDestroy(): Promise<void>;
  conversation: Pick<ConversationCoordinator, "abort" | "drain" | "stopIntake">;
  gateway: Pick<DiscordGatewayAdapter, "stop">;
  logger: Pick<JsonLinesLogger, "flush" | "log">;
  mcpClose(): Promise<void>;
  supervisorClose(): Promise<void>;
  typingRelease(): void;
  isFatal: boolean;
}): Promise<void> {
  input.logger.log("info", "application.shutdown_started");
  const failures: unknown[] = [];
  await settleCleanup(
    [
      runCleanup(() => input.gateway.stop()),
      runCleanup(() => input.conversation.stopIntake()),
      input.automation.stopIntake(),
    ],
    failures,
  );
  await settleCleanup(
    [
      input.isFatal ? input.conversation.abort() : input.conversation.drain(),
      input.automation.drain(),
    ],
    failures,
  );
  await settleCleanup(
    [
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

function createAutomationLogger(logger: JsonLinesLogger): AutomationLogPort {
  const log = (
    level: "debug" | "error" | "info" | "warn",
    event: string,
    details?: Readonly<Record<string, unknown>>,
  ) => {
    const jobId = details?.["jobId"];
    logger.log(level, event, typeof jobId === "string" ? { jobId } : {}, details, details);
  };
  return {
    debug: (event, details) => log("debug", event, details),
    error: (event, details) => log("error", event, details),
    info: (event, details) => log("info", event, details),
    warn: (event, details) => log("warn", event, details),
  };
}

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("Deferred value is unavailable");
      resolvePromise(value);
    },
  };
}
