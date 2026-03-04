import { resolve } from "node:path";

import chokidar from "chokidar";
import { CronJob } from "cron";

import type { AiService } from "../ai/ports/inbound/ai-service-port";

import {
  loadWorkspaceCronConfig,
  removeWorkspaceCronJob,
  WORKSPACE_CRON_CONFIG_FILE_NAME,
  type WorkspaceCronConfig,
  WorkspaceCronConfigError,
  type WorkspaceCronJob,
} from "./workspace-cron-config";

type CronPromptSchedulerLogger = {
  info: (...arguments_: unknown[]) => void;
  error: (...arguments_: unknown[]) => void;
};

type CronJobLike = {
  stop: () => void;
};

type ScheduledCronPromptJob = {
  cronJob: CronJobLike;
  definition: WorkspaceCronJob;
  running: boolean;
};

type WatcherEvent = "add" | "change" | "unlink" | "error";

type WatcherLike = {
  on: (event: WatcherEvent, listener: (...arguments_: unknown[]) => void) => WatcherLike;
  close: () => Promise<void>;
};

export type CronPromptCronJobOptions = {
  cronTime: string;
  onTick: () => Promise<void>;
  start: boolean;
  timeZone?: string;
  waitForCompletion: boolean;
};

type CreateCronJob = (options: CronPromptCronJobOptions) => CronJobLike;
type CreateWatcher = (configPath: string) => WatcherLike;
type LoadWorkspaceCronConfigFn = (
  configPath: string,
  timeZone: string | undefined,
) => Promise<WorkspaceCronConfig>;
type RemoveWorkspaceCronJobFn = (configPath: string, jobId: string) => Promise<boolean>;

type StartCronPromptSchedulerInput = {
  aiService: AiService;
  logger: CronPromptSchedulerLogger;
  workspaceDir: string;
  timeZone?: string;
  debounceMs?: number;
  createCronJob?: CreateCronJob;
  createWatcher?: CreateWatcher;
  loadWorkspaceCronConfig?: LoadWorkspaceCronConfigFn;
  removeWorkspaceCronJob?: RemoveWorkspaceCronJobFn;
};

export type CronPromptSchedulerHandle = {
  stop: () => Promise<void>;
};

export async function startCronPromptScheduler(
  input: StartCronPromptSchedulerInput,
): Promise<CronPromptSchedulerHandle> {
  const scheduler = new CronPromptScheduler(input);
  await scheduler.start();

  return {
    stop: async () => {
      await scheduler.stop();
    },
  };
}

class CronPromptScheduler {
  private readonly aiService: AiService;
  private readonly logger: CronPromptSchedulerLogger;
  private readonly configPath: string;
  private readonly timeZone: string | undefined;
  private readonly debounceMs: number;
  private readonly createCronJob: CreateCronJob;
  private readonly createWatcher: CreateWatcher;
  private readonly loadWorkspaceCronConfig: LoadWorkspaceCronConfigFn;
  private readonly removeWorkspaceCronJob: RemoveWorkspaceCronJobFn;

  private readonly jobs = new Map<string, ScheduledCronPromptJob>();
  private watcher: WatcherLike | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private operationChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(input: StartCronPromptSchedulerInput) {
    this.aiService = input.aiService;
    this.logger = input.logger;
    this.configPath = resolve(input.workspaceDir, WORKSPACE_CRON_CONFIG_FILE_NAME);
    this.timeZone = input.timeZone;
    this.debounceMs = input.debounceMs ?? 100;
    this.createCronJob = input.createCronJob ?? createCronJob;
    this.createWatcher = input.createWatcher ?? createWatcher;
    this.loadWorkspaceCronConfig = input.loadWorkspaceCronConfig ?? loadWorkspaceCronConfig;
    this.removeWorkspaceCronJob = input.removeWorkspaceCronJob ?? removeWorkspaceCronJob;
  }

  async start(): Promise<void> {
    await this.reload("initial");
    this.watcher = this.createWatcher(this.configPath);
    this.watcher.on("add", () => {
      this.scheduleReload();
    });
    this.watcher.on("change", () => {
      this.scheduleReload();
    });
    this.watcher.on("unlink", () => {
      this.scheduleReload();
    });
    this.watcher.on("error", (error: unknown) => {
      this.logger.error("Cron prompt watcher failed:", error);
    });

    this.logger.info("Cron prompt scheduler started.", {
      configPath: this.configPath,
      timeZone: this.timeZone ?? "system",
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }

    if (this.watcher) {
      await this.watcher.close().catch((error: unknown) => {
        this.logger.error("Failed to close cron prompt watcher:", error);
      });
      this.watcher = undefined;
    }

    await this.enqueue(async () => {
      for (const scheduledJob of this.jobs.values()) {
        scheduledJob.cronJob.stop();
      }
      this.jobs.clear();
    });
    this.logger.info("Cron prompt scheduler stopped.");
  }

  private scheduleReload(): void {
    if (this.stopped) {
      return;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.enqueue(async () => {
        await this.reload("watch");
      });
    }, this.debounceMs);
  }

  private async reload(reason: "initial" | "watch"): Promise<void> {
    const loadedConfig = await this.loadWorkspaceCronConfig(this.configPath, this.timeZone).catch(
      (error: unknown) => {
        if (error instanceof WorkspaceCronConfigError) {
          this.logger.error("Failed to load cron prompts due to invalid cron.toml:", error);
          return undefined;
        }
        this.logger.error("Failed to load cron prompts. Keeping previous schedule:", error);
        return undefined;
      },
    );
    if (!loadedConfig) {
      return;
    }

    this.reconcileJobs(loadedConfig.jobs);
    this.logger.info("Cron prompts loaded.", {
      jobCount: loadedConfig.jobs.length,
      reason,
    });
  }

  private reconcileJobs(nextJobs: ReadonlyArray<WorkspaceCronJob>): void {
    const nextJobsById = new Map(
      nextJobs.map((job) => {
        return [job.id, job] as const;
      }),
    );

    for (const [jobId, scheduledJob] of this.jobs.entries()) {
      const nextJob = nextJobsById.get(jobId);
      if (!nextJob || !isSameJobDefinition(scheduledJob.definition, nextJob)) {
        scheduledJob.cronJob.stop();
        this.jobs.delete(jobId);
      }
    }

    for (const nextJob of nextJobs) {
      if (this.jobs.has(nextJob.id)) {
        continue;
      }
      const cronJob = this.createCronJob({
        cronTime: nextJob.cronTime,
        onTick: async () => {
          await this.runJob(nextJob.id);
        },
        start: true,
        timeZone: this.timeZone,
        waitForCompletion: true,
      });
      this.jobs.set(nextJob.id, {
        cronJob,
        definition: nextJob,
        running: false,
      });
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const scheduledJob = this.jobs.get(jobId);
    if (!scheduledJob) {
      return;
    }
    if (scheduledJob.running) {
      this.logger.info("Skipped cron prompt because previous run is still active.", {
        jobId,
      });
      return;
    }
    scheduledJob.running = true;
    try {
      await this.aiService.generateHeartbeat({
        prompt: scheduledJob.definition.prompt,
        source: "cron",
      });
    } catch (error: unknown) {
      this.logger.error("Failed to run cron prompt:", {
        error,
        jobId,
      });
    } finally {
      scheduledJob.running = false;
    }

    if (!scheduledJob.definition.oneshot) {
      return;
    }

    await this.enqueue(async () => {
      await this.completeOneShot(jobId);
    });
  }

  private async completeOneShot(jobId: string): Promise<void> {
    const scheduledJob = this.jobs.get(jobId);
    if (!scheduledJob || !scheduledJob.definition.oneshot) {
      return;
    }

    scheduledJob.cronJob.stop();
    this.jobs.delete(jobId);

    await this.removeWorkspaceCronJob(this.configPath, jobId)
      .then((removed) => {
        this.logger.info("Processed oneshot cron prompt.", {
          jobId,
          removedFromConfig: removed,
        });
      })
      .catch((error: unknown) => {
        this.logger.error("Failed to update cron.toml after oneshot run:", {
          error,
          jobId,
        });
      });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const chained = this.operationChain.then(operation, operation);
    this.operationChain = chained.then(
      () => undefined,
      () => undefined,
    );

    await chained;
  }
}

function createCronJob(options: CronPromptCronJobOptions): CronJobLike {
  return CronJob.from(options);
}

function createWatcher(configPath: string): WatcherLike {
  return chokidar.watch(configPath, {
    ignoreInitial: true,
  });
}

function isSameJobDefinition(left: WorkspaceCronJob, right: WorkspaceCronJob): boolean {
  return (
    left.id === right.id &&
    left.cronTime === right.cronTime &&
    left.prompt === right.prompt &&
    left.oneshot === right.oneshot
  );
}
