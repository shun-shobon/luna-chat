type RecurringScheduleJob = {
	check?: string;
	cron: string;
	enabled: boolean;
	id: string;
	kind: "recurring";
	prompt: string;
};

type OneShotScheduleJob = {
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
