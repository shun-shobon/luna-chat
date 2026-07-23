import { CronJob } from "cron";

import type {
  AutomationScheduleTimerPort,
  ScheduledAutomationJob,
} from "../ports/automation-schedule-port";

export class CronScheduleTimer implements AutomationScheduleTimerPort {
  scheduleOneShot(at: Date, onTick: () => Promise<void>): ScheduledAutomationJob {
    return createCronJob(at, onTick);
  }

  scheduleRecurring(cron: string, onTick: () => Promise<void>): ScheduledAutomationJob {
    return createCronJob(cron, onTick);
  }
}

function createCronJob(
  cronTime: Date | string,
  onTick: () => Promise<void>,
): ScheduledAutomationJob {
  const job = CronJob.from({
    cronTime,
    onTick,
    start: true,
    waitForCompletion: false,
  });

  return {
    stop: () => {
      void job.stop();
    },
  };
}
