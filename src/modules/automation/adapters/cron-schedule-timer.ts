import { CronJob } from "cron";

import type {
	AutomationScheduleTimerPort,
	ScheduledAutomationJob,
} from "../ports/automation-schedule-port";

export class CronScheduleTimer implements AutomationScheduleTimerPort {
	schedule(cronTime: Date | string, onTick: () => Promise<void>): ScheduledAutomationJob {
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
}
