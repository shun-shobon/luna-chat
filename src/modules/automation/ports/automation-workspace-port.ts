import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";

export interface AutomationWorkspacePort {
  readHeartbeatChecklist(): Promise<string>;
  readSchedule(): Promise<WorkspaceSchedule>;
  removeScheduleJob(jobId: string): boolean;
}
