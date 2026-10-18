import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChildProcessCheckRunner } from "./child-process-check-runner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (path) => {
			await rm(path, { force: true, recursive: true });
		}),
	);
});

describe("ChildProcessCheckRunner", () => {
	it("workspaceをcwdとしてshで実行し、tokenを除いた環境と閉じた標準入力を渡す", async () => {
		const workspaceDir = await createTemporaryDirectory();
		const runner = createRunner({
			cwd: workspaceDir,
			parentEnvironment: { ...process.env, DISCORD_BOT_TOKEN: "secret", LUNA_CHECK_VALUE: "kept" },
		});

		const result = await runner.run(
			'pwd; echo "${DISCORD_BOT_TOKEN-unset}"; echo "$LUNA_CHECK_VALUE"; cat; echo done',
		);

		expect(result).toEqual({
			status: "succeeded",
			stdout: `${await realpath(workspaceDir)}\nunset\nkept\ndone\n`,
		});
	});

	it("非0終了を標準エラー出力とともに失敗として返す", async () => {
		const runner = createRunner({ cwd: await createTemporaryDirectory() });

		await expect(runner.run("echo partial; echo 'fetch failed' >&2; exit 3")).resolves.toEqual({
			error: undefined,
			exitCode: 3,
			signal: null,
			status: "failed",
			stderr: "fetch failed\n",
			timedOut: false,
		});
	});

	it("シグナルによる終了を失敗として返す", async () => {
		const runner = createRunner({ cwd: await createTemporaryDirectory() });

		await expect(runner.run("kill -TERM $$")).resolves.toMatchObject({
			exitCode: null,
			signal: "SIGTERM",
			status: "failed",
			timedOut: false,
		});
	});

	it("タイムアウトでプロセスグループにSIGTERMを送り失敗として返す", async () => {
		const runner = createRunner({ cwd: await createTemporaryDirectory(), timeoutMs: 100 });

		await expect(runner.run("echo started; sleep 10; echo finished")).resolves.toMatchObject({
			status: "failed",
			timedOut: true,
		});
	});

	it("SIGTERMを無視するcheckは猶予後にプロセスグループごとSIGKILLする", async () => {
		const runner = createRunner({
			cwd: await createTemporaryDirectory(),
			killGraceMs: 100,
			timeoutMs: 100,
		});

		await expect(runner.run("trap '' TERM; sleep 10; sleep 10")).resolves.toMatchObject({
			exitCode: null,
			signal: "SIGKILL",
			status: "failed",
			timedOut: true,
		});
	});

	it("起動できないcheckをerror付きの失敗として返す", async () => {
		const workspaceDir = join(await createTemporaryDirectory(), "missing");
		const runner = createRunner({ cwd: workspaceDir });

		await expect(runner.run("echo unreachable")).resolves.toMatchObject({
			error: expect.objectContaining({ code: "ENOENT" }),
			exitCode: null,
			signal: null,
			status: "failed",
			timedOut: false,
		});
	});

	it("大量の標準出力は先頭64000文字だけを保持する", async () => {
		const runner = createRunner({ cwd: await createTemporaryDirectory() });

		await expect(runner.run("printf 'head'; yes | head -c 1000000")).resolves.toEqual({
			status: "succeeded",
			stdout: `head${"y\n".repeat(31_998)}`,
		});
	});
});

function createRunner(input: {
	cwd: string;
	killGraceMs?: number;
	parentEnvironment?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): ChildProcessCheckRunner {
	return new ChildProcessCheckRunner({
		cwd: input.cwd,
		killGraceMs: input.killGraceMs ?? 5_000,
		parentEnvironment: input.parentEnvironment ?? process.env,
		timeoutMs: input.timeoutMs ?? 10_000,
	});
}

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "luna-check-runner-"));
	temporaryDirectories.push(directory);
	return directory;
}
