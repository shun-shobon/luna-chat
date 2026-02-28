import { CronJob } from "cron";

import type { AiService } from "../ai/application/channel-session-coordinator";

const DEFAULT_HEARTBEAT_CRON = "0 0,30 * * * *";
const DEFAULT_HEARTBEAT_TIME_ZONE = "Asia/Tokyo";

type HeartbeatLogger = {
  info: (...arguments_: unknown[]) => void;
  error: (...arguments_: unknown[]) => void;
};

type CronJobLike = {
  stop: () => void;
};

export type HeartbeatCronJobOptions = {
  cronTime: string;
  onTick: () => Promise<void>;
  start: boolean;
  timeZone: string;
  waitForCompletion: boolean;
};

type CreateCronJob = (options: HeartbeatCronJobOptions) => CronJobLike;

type StartHeartbeatRunnerInput = {
  aiService: AiService;
  logger: HeartbeatLogger;
  prompt: string;
  cronTime?: string;
  timeZone?: string;
  createCronJob?: CreateCronJob;
};

export type HeartbeatRunnerHandle = {
  stop: () => void;
};

export function startHeartbeatRunner(input: StartHeartbeatRunnerInput): HeartbeatRunnerHandle {
  const cronTime = input.cronTime ?? DEFAULT_HEARTBEAT_CRON;
  const timeZone = input.timeZone ?? DEFAULT_HEARTBEAT_TIME_ZONE;

  const job = (input.createCronJob ?? createCronJob)({
    cronTime,
    onTick: async () => {
      await input.aiService.generateHeartbeat({ prompt: input.prompt }).catch((error: unknown) => {
        input.logger.error("Failed to run heartbeat:", error);
      });
    },
    start: true,
    timeZone,
    waitForCompletion: true,
  });

  input.logger.info("Heartbeat runner started.", {
    cronTime,
    timeZone,
  });

  return {
    stop: () => {
      job.stop();
      input.logger.info("Heartbeat runner stopped.");
    },
  };
}

function createCronJob(options: HeartbeatCronJobOptions): CronJobLike {
  return CronJob.from(options);
}
