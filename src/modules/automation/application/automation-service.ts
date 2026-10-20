import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";
import type {
	AutomationStatus,
	HeartbeatStatus,
	MemoryMaintenanceStatus,
	ScheduleJobStatus,
} from "../ports/automation-status";

interface AutomationControl {
	drain(): Promise<void>;
	start(initialSchedule: WorkspaceSchedule): Promise<void> | void;
	stopIntake(): Promise<void> | void;
}

type StatusReportingControl<Status> = AutomationControl & { snapshot(): Status };

export class AutomationService {
	readonly #controls: readonly AutomationControl[];
	readonly #heartbeat: StatusReportingControl<HeartbeatStatus>;
	readonly #memoryMaintenance: StatusReportingControl<MemoryMaintenanceStatus>;
	readonly #schedule: StatusReportingControl<readonly ScheduleJobStatus[]>;

	constructor(input: {
		heartbeat: StatusReportingControl<HeartbeatStatus>;
		memoryMaintenance: StatusReportingControl<MemoryMaintenanceStatus>;
		retention: AutomationControl;
		schedule: StatusReportingControl<readonly ScheduleJobStatus[]>;
	}) {
		this.#controls = [input.retention, input.schedule, input.memoryMaintenance, input.heartbeat];
		this.#heartbeat = input.heartbeat;
		this.#memoryMaintenance = input.memoryMaintenance;
		this.#schedule = input.schedule;
	}

	snapshot(): AutomationStatus {
		return {
			heartbeat: this.#heartbeat.snapshot(),
			memoryMaintenance: this.#memoryMaintenance.snapshot(),
			schedule: this.#schedule.snapshot(),
		};
	}

	async startAutomation(initialSchedule: WorkspaceSchedule): Promise<void> {
		for (const control of this.#controls) await control.start(initialSchedule);
	}

	async stopIntake(): Promise<void> {
		await Promise.all(this.#controls.map(async (control) => await control.stopIntake()));
	}

	async drain(): Promise<void> {
		await Promise.all(this.#controls.map(async (control) => await control.drain()));
	}
}
