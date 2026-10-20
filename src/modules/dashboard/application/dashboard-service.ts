import type { DashboardSourcePort } from "../ports/dashboard-source-port";

export type DashboardSnapshot = Readonly<{
	activity: ReturnType<DashboardSourcePort["activity"]>;
	agent: ReturnType<DashboardSourcePort["agent"]>;
	automation: ReturnType<DashboardSourcePort["automation"]>;
	conversations: ReturnType<DashboardSourcePort["conversations"]>;
	events: ReturnType<DashboardSourcePort["events"]>;
	generatedAt: string;
	startedAt: string;
	tasks: ReturnType<DashboardSourcePort["tasks"]>;
}>;

export class DashboardService {
	constructor(
		private readonly dependencies: Readonly<{
			now: () => Date;
			sources: DashboardSourcePort;
			startedAt: Date;
		}>,
	) {}

	snapshot(): DashboardSnapshot {
		const { now, sources, startedAt } = this.dependencies;
		return {
			activity: sources.activity(),
			agent: sources.agent(),
			automation: sources.automation(),
			conversations: sources.conversations(),
			events: sources.events(),
			generatedAt: now().toISOString(),
			startedAt: startedAt.toISOString(),
			tasks: sources.tasks(),
		};
	}
}
