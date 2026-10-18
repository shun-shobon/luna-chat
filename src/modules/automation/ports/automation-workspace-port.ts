import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";

export interface AutomationWorkspacePort {
	readHeartbeatContext(): Promise<Readonly<{ checklist: string; agenda: string }>>;
	readSchedule(): Promise<WorkspaceSchedule>;
	removeScheduleJob(jobId: string): void;
}
