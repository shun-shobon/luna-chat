import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";

interface AutomationControl {
	drain(): Promise<void>;
	start(initialSchedule: WorkspaceSchedule): Promise<void> | void;
	stopIntake(): Promise<void> | void;
}

export class AutomationService {
	readonly #controls: readonly AutomationControl[];

	constructor(input: {
		heartbeat: AutomationControl;
		memoryMaintenance: AutomationControl;
		retention: AutomationControl;
		schedule: AutomationControl;
	}) {
		this.#controls = [input.retention, input.schedule, input.memoryMaintenance, input.heartbeat];
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
