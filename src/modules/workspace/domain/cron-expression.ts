import { CronTime } from "cron";

export function isValidFiveFieldCron(value: string): boolean {
  if (value.trim().split(/\s+/u).length !== 5) {
    return false;
  }

  try {
    new CronTime(value);
    return true;
  } catch {
    return false;
  }
}
