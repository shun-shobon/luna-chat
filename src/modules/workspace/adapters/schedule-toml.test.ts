import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceSchedule } from "../domain/workspace-schedule";

import {
  createWorkspaceScheduleFile,
  parseWorkspaceSchedule,
  readWorkspaceSchedule,
  removeWorkspaceScheduleJob,
  serializeWorkspaceSchedule,
  writeWorkspaceSchedule,
} from "./schedule-toml";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

describe("workspace schedule TOML", () => {
  it("空ファイルと明示的な空配列を0件のジョブとして読む", () => {
    expect(parseWorkspaceSchedule("")).toEqual({ jobs: [] });
    expect(parseWorkspaceSchedule("jobs = []\n")).toEqual({ jobs: [] });
  });

  it("定期ジョブと一度だけのジョブを判別して読む", () => {
    expect(parseWorkspaceSchedule(SCHEDULE_SOURCE)).toEqual(SCHEDULE);
  });

  it.each([
    ["unknown top-level key", "unexpected = true"],
    ["unknown job key", `${RECURRING_JOB_SOURCE}\nunexpected = true`],
    ["duplicate id", `${RECURRING_JOB_SOURCE}\n${RECURRING_JOB_SOURCE}`],
    [
      "six-field cron",
      `${RECURRING_JOB_SOURCE.replace('cron = "0 9 * * *"', 'cron = "0 0 9 * * *"')}`,
    ],
    [
      "invalid cron",
      `${RECURRING_JOB_SOURCE.replace('cron = "0 9 * * *"', 'cron = "invalid cron"')}`,
    ],
    ["recurring job with at", `${RECURRING_JOB_SOURCE}\nat = "2026-08-01T10:00:00+09:00"`],
    ["one-shot job without offset", `${ONE_SHOT_JOB_SOURCE.replace("+09:00", "")}`],
    ["one-shot job with cron", `${ONE_SHOT_JOB_SOURCE}\ncron = "0 9 * * *"`],
  ])("%s を拒否する", (_title, source) => {
    expect(() => parseWorkspaceSchedule(source)).toThrow("cron.toml is invalid");
  });

  it("ジョブを TOML に直列化して往復できる", () => {
    const source = serializeWorkspaceSchedule(SCHEDULE);

    expect(source).toContain("[[jobs]]");
    expect(source).toContain('kind = "one_shot"');
    expect(parseWorkspaceSchedule(source)).toEqual(SCHEDULE);
  });

  it("排他的な初期作成と同期上書きを行う", async () => {
    const directory = await createTemporaryDirectory();
    const schedulePath = resolve(directory, "cron.toml");

    await createWorkspaceScheduleFile(schedulePath);
    await expect(readWorkspaceSchedule(schedulePath)).resolves.toEqual({ jobs: [] });
    await expect(createWorkspaceScheduleFile(schedulePath)).rejects.toMatchObject({
      code: "EEXIST",
    });

    writeWorkspaceSchedule(schedulePath, SCHEDULE);
    await expect(readWorkspaceSchedule(schedulePath)).resolves.toEqual(SCHEDULE);
  });

  it("削除直前にファイルを再読込し、対象ジョブだけを同期的に削除する", async () => {
    const directory = await createTemporaryDirectory();
    const schedulePath = resolve(directory, "cron.toml");
    await writeFile(schedulePath, serializeWorkspaceSchedule(SCHEDULE), "utf8");

    expect(removeWorkspaceScheduleJob(schedulePath, "morning")).toBe(true);
    expect(parseWorkspaceSchedule(await readFile(schedulePath, "utf8"))).toEqual({
      jobs: [SCHEDULE.jobs[1]],
    });
    expect(removeWorkspaceScheduleJob(schedulePath, "missing")).toBe(false);
  });
});

const RECURRING_JOB_SOURCE = `[[jobs]]
id = "morning"
enabled = true
prompt = "朝の確認"
kind = "recurring"
cron = "0 9 * * *"`;

const ONE_SHOT_JOB_SOURCE = `[[jobs]]
id = "release"
enabled = false
prompt = "リリース確認"
kind = "one_shot"
at = "2026-08-01T10:00:00+09:00"`;

const SCHEDULE_SOURCE = `${RECURRING_JOB_SOURCE}\n\n${ONE_SHOT_JOB_SOURCE}\n`;

const SCHEDULE: WorkspaceSchedule = {
  jobs: [
    {
      cron: "0 9 * * *",
      enabled: true,
      id: "morning",
      kind: "recurring",
      prompt: "朝の確認",
    },
    {
      at: "2026-08-01T10:00:00+09:00",
      enabled: false,
      id: "release",
      kind: "one_shot",
      prompt: "リリース確認",
    },
  ],
};

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "luna-workspace-schedule-"));
  temporaryDirectories.push(directory);
  return directory;
}
