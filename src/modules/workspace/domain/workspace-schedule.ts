export type RecurringScheduleJob = {
  cron: string;
  enabled: boolean;
  id: string;
  kind: "recurring";
  prompt: string;
};

export type OneShotScheduleJob = {
  at: string;
  enabled: boolean;
  id: string;
  kind: "one_shot";
  prompt: string;
};

export type WorkspaceScheduleJob = RecurringScheduleJob | OneShotScheduleJob;

export type WorkspaceSchedule = {
  jobs: WorkspaceScheduleJob[];
};

export const EMPTY_WORKSPACE_SCHEDULE: WorkspaceSchedule = {
  jobs: [],
};
