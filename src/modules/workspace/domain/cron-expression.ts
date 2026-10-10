import { CronTime } from "cron";

export function isValidFiveFieldCron(value: string): boolean {
  if (value.trim().split(/\s+/u).length !== 5) {
    return false;
  }

  return CronTime.validateCronExpression(value).valid;
}
