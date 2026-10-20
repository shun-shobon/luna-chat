import type { WorkspaceScheduleJob } from "../../workspace/domain/workspace-schedule";

export type HeartbeatStatus = Readonly<{ enabled: boolean; nextFireAt: string | null }>;

export type MemoryMaintenanceStatus = Readonly<{
	cron: string;
	enabled: boolean;
	nextFireAt: string | null;
}>;

export type ScheduleJobStatus = Readonly<{
	check: string | null;
	cron: string | null;
	id: string;
	kind: WorkspaceScheduleJob["kind"];
	nextFireAt: string | null;
	prompt: string;
}>;

export type AutomationStatus = Readonly<{
	heartbeat: HeartbeatStatus;
	memoryMaintenance: MemoryMaintenanceStatus;
	schedule: readonly ScheduleJobStatus[];
}>;
