import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentTool, AgentToolResult } from "../../../ports/outbound/agent-session-port";
import { createShellTools } from "./shell-tools";
import type { ShellTools } from "./shell-tools";

const HEADER_PATTERN = /^Chunk ID: [0-9a-f]{6}\nWall time: \d+\.\d{4} seconds\n/u;

let workspace: string;
let shellTools: ShellTools;

beforeEach(async () => {
	workspace = await realpath(await mkdtemp(path.join(tmpdir(), "shell-tools-")));
	shellTools = createShellTools({ cwd: workspace, env: process.env });
});

afterEach(async () => {
	await shellTools.dispose();
	await rm(workspace, { recursive: true, force: true });
});

function tool(tools: ShellTools, name: string): AgentTool {
	const found = tools.tools.find((candidate) => candidate.name === name);
	if (found == null) {
		throw new Error(`tool ${name} is missing`);
	}
	return found;
}

function execCommand(
	argumentsValue: unknown,
	signal = new AbortController().signal,
	tools = shellTools,
): Promise<AgentToolResult> {
	return tool(tools, "exec_command").execute(argumentsValue, signal);
}

function writeStdin(
	argumentsValue: unknown,
	signal = new AbortController().signal,
	tools = shellTools,
): Promise<AgentToolResult> {
	return tool(tools, "write_stdin").execute(argumentsValue, signal);
}

function sessionIdOf(result: AgentToolResult): number {
	const match = /Process running with session ID (\d+)/u.exec(result.text);
	if (match?.[1] == null) {
		throw new Error(`session id is missing: ${result.text}`);
	}
	return Number(match[1]);
}

function outputOf(result: AgentToolResult): string {
	const index = result.text.indexOf("\nOutput:\n");
	if (index === -1) {
		throw new Error(`output is missing: ${result.text}`);
	}
	return result.text.slice(index + "\nOutput:\n".length);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) {
			return true;
		}
		await delay(20);
	}
	return !isAlive(pid);
}

function parsePids(result: AgentToolResult): number[] {
	return outputOf(result).trim().split(/\s+/u).map(Number);
}

describe("exec_command", () => {
	it("すぐ終わるコマンドは終了コード0と出力を返す", async () => {
		const result = await execCommand({ cmd: "echo hello", login: false });

		expect(result.isError).toBe(false);
		expect(result.images).toEqual([]);
		expect(result.text).toMatch(HEADER_PATTERN);
		expect(result.text).toMatch(
			/\nProcess exited with code 0\nOriginal token count: 2\nOutput:\nhello\n$/u,
		);
		expect(result.text).not.toContain("session ID");
	});

	it("非0終了はエラー扱いにせず終了コードと標準エラーを返す", async () => {
		const result = await execCommand({ cmd: "echo oops >&2; exit 3", login: false });

		expect(result.isError).toBe(false);
		expect(result.text).toContain("Process exited with code 3");
		expect(outputOf(result)).toBe("oops\n");
	});

	it("workdirを省くとcwd、相対パスならcwd基準で解決する", async () => {
		await mkdir(path.join(workspace, "sub"));

		const fromCwd = await execCommand({ cmd: "pwd -P", login: false });
		const fromSub = await execCommand({ cmd: "pwd -P", workdir: "sub", login: false });

		expect(outputOf(fromCwd)).toBe(`${workspace}\n`);
		expect(outputOf(fromSub)).toBe(`${path.join(workspace, "sub")}\n`);
	});

	it("存在しないworkdirはエラー結果を返す", async () => {
		const result = await execCommand({ cmd: "true", workdir: "missing", login: false });

		expect(result.isError).toBe(true);
		expect(result.text).toContain("exec_command failed: Failed to create unified exec process");
	});

	it("既定でログインシェルとして起動し、login=falseで外せる", async () => {
		const script = "shopt -q login_shell && echo login || echo nologin";

		const login = await execCommand({ cmd: script });
		const noLogin = await execCommand({ cmd: script, login: false });

		expect(outputOf(login)).toContain("login\n");
		expect(outputOf(login)).not.toContain("nologin");
		expect(outputOf(noLogin)).toBe("nologin\n");
	});

	it("Codexと同じ非対話向けの環境変数を上書きし、渡された環境変数は引き継ぐ", async () => {
		const tools = createShellTools({
			cwd: workspace,
			env: { PATH: process.env["PATH"], FOO: "bar" },
		});
		try {
			const result = await execCommand(
				{ cmd: "echo $FOO $TERM $PAGER $NO_COLOR", login: false },
				undefined,
				tools,
			);
			expect(outputOf(result)).toBe("bar dumb cat 1\n");
		} finally {
			await tools.dispose();
		}
	});

	it("tty省略時は標準入力が閉じている", async () => {
		const result = await execCommand({ cmd: "cat; echo done", login: false });

		expect(result.text).toContain("Process exited with code 0");
		expect(outputOf(result)).toBe("done\n");
	});

	it("yield_time_msを過ぎてもプロセスが続くならsession IDを返して生かしておく", async () => {
		const startedAt = Date.now();
		const result = await execCommand({
			cmd: "echo start; sleep 1; echo end",
			yield_time_ms: 0,
			login: false,
		});

		expect(Date.now() - startedAt).toBeLessThan(900);
		expect(result.isError).toBe(false);
		expect(result.text).not.toContain("Process exited");
		expect(outputOf(result)).toBe("start\n");

		const polled = await writeStdin({ session_id: sessionIdOf(result) });

		expect(polled.isError).toBe(false);
		expect(polled.text).toContain("Process exited with code 0");
		expect(polled.text).not.toContain("session ID");
		expect(outputOf(polled)).toBe("end\n");
	});

	it("不正な引数はisErrorで返しプロセスを起動しない", async () => {
		for (const argumentsValue of [
			{},
			{ cmd: 1 },
			{ cmd: "true", yield_time_ms: -1 },
			{ cmd: "true", tty: "yes" },
			"echo hi",
		]) {
			const result = await execCommand(argumentsValue);
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/^failed to parse function arguments: /u);
		}
	});

	it("収集上限を超えた出力は先頭と末尾を残し、省略したバイト数を示す", async () => {
		const result = await execCommand({
			cmd: "printf 'HEAD\\n'; head -c 2097152 /dev/zero | tr '\\0' 'x'; printf '\\nTAIL\\n'",
			login: false,
		});
		const totalBytes = 5 + 2_097_152 + 6;
		const output = outputOf(result);

		expect(result.text).toContain(`Original token count: ${String(Math.ceil(totalBytes / 4))}`);
		expect(
			output.startsWith(
				`Warning: truncated output (original token count: ${String(Math.ceil(totalBytes / 4))})\n... ${String(totalBytes - 1024 * 1024)} bytes omitted ...\n\nHEAD\n`,
			),
		).toBe(true);
		expect(output).toMatch(/x…\d+ tokens truncated…x/u);
		expect(output.endsWith("x\nTAIL\n")).toBe(true);
	});

	it("max_output_tokensを超える出力は中央を切り詰める", async () => {
		const result = await execCommand({
			cmd: "head -c 100000 /dev/zero | tr '\\0' 'a'",
			max_output_tokens: 100,
			login: false,
		});

		expect(outputOf(result)).toBe(
			`Warning: truncated output (original token count: 25000)\nTotal output lines: 1\n\n${"a".repeat(200)}…24900 tokens truncated…${"a".repeat(200)}`,
		);
	});

	it("AbortSignalで待機を打ち切り、Codexと同じくプロセスは生かしたままsession IDを返す", async () => {
		const controller = new AbortController();
		const running = execCommand({ cmd: "echo $$; exec sleep 30", login: false }, controller.signal);
		await delay(300);
		const startedAt = Date.now();
		controller.abort();
		const result = await running;

		expect(Date.now() - startedAt).toBeLessThan(500);
		const sessionId = sessionIdOf(result);
		const [pid] = parsePids(result);
		expect(pid).toBeDefined();
		expect(isAlive(pid ?? 0)).toBe(true);

		const pollController = new AbortController();
		const polling = writeStdin({ session_id: sessionId }, pollController.signal);
		await delay(100);
		pollController.abort();
		const polled = await polling;
		expect(polled.text).toContain(`Process running with session ID ${String(sessionId)}`);

		await shellTools.dispose();
		expect(await waitForExit(pid ?? 0)).toBe(true);
	}, 10_000);
});

describe("write_stdin", () => {
	it("tty=trueなら標準入力へ書き込み、増えた出力を返す", async () => {
		const started = await execCommand({
			cmd: 'while IFS= read -r line; do echo "got:$line"; done',
			tty: true,
			yield_time_ms: 250,
			login: false,
		});
		const sessionId = sessionIdOf(started);

		const first = await writeStdin({ session_id: sessionId, chars: "alpha\n", yield_time_ms: 300 });
		const second = await writeStdin({ session_id: sessionId, chars: "beta\n", yield_time_ms: 300 });

		expect(outputOf(first)).toBe("got:alpha\n");
		expect(outputOf(second)).toBe("got:beta\n");
		expect(second.text).toContain(`Process running with session ID ${String(sessionId)}`);
	});

	it("Ctrl-Cはプロセスグループへ SIGINT を送る", async () => {
		const started = await execCommand({
			cmd: "trap 'echo INT-TRAP; exit 42' INT; echo READY; while true; do sleep 0.1; done",
			yield_time_ms: 300,
			login: false,
		});
		expect(outputOf(started)).toBe("READY\n");

		const interrupted = await writeStdin({
			session_id: sessionIdOf(started),
			chars: "\u0003",
			yield_time_ms: 2_000,
		});

		expect(interrupted.text).toContain("Process exited with code 42");
		expect(outputOf(interrupted)).toBe("INT-TRAP\n");
	});

	it("標準入力を読まないプロセスへの大きな書き込みでもyield_time_msで戻る", async () => {
		const started = await execCommand({
			cmd: "sleep 30",
			tty: true,
			yield_time_ms: 250,
			login: false,
		});
		const sessionId = sessionIdOf(started);

		const startedAt = Date.now();
		const result = await writeStdin({
			session_id: sessionId,
			chars: "x".repeat(1024 * 1024),
			yield_time_ms: 300,
		});

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(result.text).toContain(`Process running with session ID ${String(sessionId)}`);
	});

	it("tty=falseのセッションへの書き込みはCodexと同じエラーを返す", async () => {
		const started = await execCommand({ cmd: "sleep 30", yield_time_ms: 250, login: false });

		const result = await writeStdin({ session_id: sessionIdOf(started), chars: "x" });

		expect(result).toEqual({
			text: "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
			images: [],
			isError: true,
		});
	});

	it("終了を返した後のsession IDは不明なIDとして扱う", async () => {
		const started = await execCommand({
			cmd: "read -r line; echo $line",
			tty: true,
			yield_time_ms: 250,
			login: false,
		});
		const sessionId = sessionIdOf(started);

		const finished = await writeStdin({
			session_id: sessionId,
			chars: "bye\n",
			yield_time_ms: 1_000,
		});
		const after = await writeStdin({ session_id: sessionId, chars: "" });

		expect(finished.text).toContain("Process exited with code 0");
		expect(outputOf(finished)).toBe("bye\n");
		expect(after).toEqual({
			text: `write_stdin failed: Unknown process id ${String(sessionId)}`,
			images: [],
			isError: true,
		});
	});

	it("不正な引数はisErrorで返す", async () => {
		for (const argumentsValue of [
			{},
			{ session_id: "1" },
			{ session_id: 1.5 },
			{ session_id: 1, chars: 1 },
		]) {
			const result = await writeStdin(argumentsValue);
			expect(result.isError).toBe(true);
			expect(result.text).toMatch(/^failed to parse function arguments: /u);
		}
	});
});

describe("プロセスの後始末", () => {
	it("disposeでプロセスグループ全体にSIGTERMを送る", async () => {
		const started = await execCommand({
			cmd: "sleep 30 & echo $$ $!; wait",
			yield_time_ms: 500,
			login: false,
		});
		const pids = parsePids(started);
		expect(pids).toHaveLength(2);
		expect(pids.every((pid) => isAlive(pid))).toBe(true);

		await shellTools.dispose();

		for (const pid of pids) {
			expect(await waitForExit(pid)).toBe(true);
		}
		const after = await execCommand({ cmd: "true", login: false });
		expect(after.isError).toBe(true);
	});

	it("SIGTERMを無視するグループは猶予の後にSIGKILLで止める", async () => {
		const started = await execCommand({
			cmd: "trap '' TERM; echo $$; while true; do sleep 0.1; done",
			yield_time_ms: 300,
			login: false,
		});
		const [pid] = parsePids(started);
		expect(isAlive(pid ?? 0)).toBe(true);

		const startedAt = Date.now();
		await shellTools.dispose();

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
		expect(await waitForExit(pid ?? 0)).toBe(true);
	}, 10_000);

	it("終了済みのコマンドが残したバックグラウンドの子もグループごと止める", async () => {
		const result = await execCommand({ cmd: "sleep 30 & echo $!", login: false });
		const [pid] = parsePids(result);

		expect(result.text).toContain("Process exited with code 0");
		expect(await waitForExit(pid ?? 0)).toBe(true);
	});

	it("同時セッション数が上限に達したら最も長く使われていないセッションを止める", async () => {
		const tools = createShellTools({ cwd: workspace, env: process.env, maxSessions: 2 });
		try {
			const start = (): Promise<AgentToolResult> =>
				execCommand(
					{ cmd: "echo $$; exec sleep 30", yield_time_ms: 250, login: false },
					undefined,
					tools,
				);
			const first = await start();
			const second = await start();
			const third = await start();
			const [firstPid] = parsePids(first);

			expect(await waitForExit(firstPid ?? 0)).toBe(true);
			expect(await writeStdin({ session_id: sessionIdOf(first) }, undefined, tools)).toEqual({
				text: `write_stdin failed: Unknown process id ${String(sessionIdOf(first))}`,
				images: [],
				isError: true,
			});
			for (const result of [second, third]) {
				const [pid] = parsePids(result);
				expect(isAlive(pid ?? 0)).toBe(true);
			}
		} finally {
			await tools.dispose();
		}
	});
});

describe("ツール定義", () => {
	it("Codexと同じ名前と必須引数を公開する", () => {
		expect(
			shellTools.tools.map((candidate) => [candidate.name, candidate.parameters["required"]]),
		).toEqual([
			["exec_command", ["cmd"]],
			["write_stdin", ["session_id"]],
		]);
	});
});
