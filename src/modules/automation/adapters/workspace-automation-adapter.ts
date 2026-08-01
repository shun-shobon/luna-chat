import {
  readWorkspaceSchedule,
  removeWorkspaceScheduleJob,
} from "../../workspace/adapters/schedule-toml";
import { readHeartbeatChecklist } from "../../workspace/application/workspace-instructions";
import type { WorkspaceSchedule } from "../../workspace/domain/workspace-schedule";
import type { AutomationWorkspacePort } from "../ports/automation-workspace-port";

export class WorkspaceAutomationAdapter implements AutomationWorkspacePort {
  readonly #schedulePath: string;
  readonly #workspaceDir: string;

  constructor(input: { schedulePath: string; workspaceDir: string }) {
    this.#schedulePath = input.schedulePath;
    this.#workspaceDir = input.workspaceDir;
  }

  async readHeartbeatChecklist(): Promise<string> {
    return readHeartbeatChecklist(this.#workspaceDir);
  }

  async readSchedule(): Promise<WorkspaceSchedule> {
    return readWorkspaceSchedule(this.#schedulePath);
  }

  removeScheduleJob(jobId: string): boolean {
    return removeWorkspaceScheduleJob(this.#schedulePath, jobId);
  }
}
