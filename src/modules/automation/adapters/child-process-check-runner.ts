import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type {
	AutomationCheckResult,
	AutomationCheckRunnerPort,
} from "../ports/automation-check-runner-port";

// 全量を保持すると暴走したcheckの出力でメモリを使い切るため、仕様上の切り詰め長より十分長い分だけ保持する。
const RETAINED_OUTPUT_LENGTH = 64_000;

type CheckProcess = ChildProcessByStdio<null, Readable, Readable>;

export class ChildProcessCheckRunner implements AutomationCheckRunnerPort {
	readonly #cwd: string;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #killGraceMs: number;
	readonly #timeoutMs: number;

	constructor(input: {
		cwd: string;
		killGraceMs: number;
		parentEnvironment: NodeJS.ProcessEnv;
		timeoutMs: number;
	}) {
		this.#cwd = input.cwd;
		this.#environment = createCheckEnvironment(input.parentEnvironment);
		this.#killGraceMs = input.killGraceMs;
		this.#timeoutMs = input.timeoutMs;
	}

	async run(command: string): Promise<AutomationCheckResult> {
		let child: CheckProcess;
		try {
			// detachedで独立したプロセスグループにし、タイムアウト時にshが起動した子孫プロセスもまとめて終了させる。
			child = spawn("/bin/sh", ["-c", command], {
				cwd: this.#cwd,
				detached: true,
				env: this.#environment,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error: unknown) {
			return { error, exitCode: null, signal: null, status: "failed", stderr: "", timedOut: false };
		}
		return await this.#collect(child);
	}

	async #collect(child: CheckProcess): Promise<AutomationCheckResult> {
		return await new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let processError: unknown;
			let timedOut = false;
			let killTimer: NodeJS.Timeout | undefined;
			const timeoutTimer = setTimeout(() => {
				timedOut = true;
				signalProcessGroup(child, "SIGTERM");
				killTimer = setTimeout(() => {
					signalProcessGroup(child, "SIGKILL");
					// グループ外へ逃げた子孫がパイプを握り続けるとcloseが来ないため、読み取り側を閉じて決着させる。
					child.stdout.destroy();
					child.stderr.destroy();
				}, this.#killGraceMs);
			}, this.#timeoutMs);
			const settle = (result: AutomationCheckResult): void => {
				clearTimeout(timeoutTimer);
				clearTimeout(killTimer);
				resolve(result);
			};

			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				if (stdout.length < RETAINED_OUTPUT_LENGTH) {
					stdout = (stdout + chunk).slice(0, RETAINED_OUTPUT_LENGTH);
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-RETAINED_OUTPUT_LENGTH);
			});
			child.on("error", (error) => {
				processError = error;
				if (child.pid === undefined) {
					settle({ error, exitCode: null, signal: null, status: "failed", stderr, timedOut });
				}
			});
			child.once("close", (exitCode, signal) => {
				if (exitCode === 0 && !timedOut && processError === undefined) {
					settle({ status: "succeeded", stdout });
					return;
				}
				settle({ error: processError, exitCode, signal, status: "failed", stderr, timedOut });
			});
		});
	}
}

function createCheckEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parentEnvironment)) {
		if (typeof value === "string" && key !== "DISCORD_BOT_TOKEN") {
			environment[key] = value;
		}
	}
	return environment;
}

function signalProcessGroup(child: CheckProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) {
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		// 既に終了したグループへの送信はESRCHになるが、結果はcloseで確定するため無視する。
	}
}
