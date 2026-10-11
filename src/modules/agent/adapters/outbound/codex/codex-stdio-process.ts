import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

import { createCodexChildEnvironment } from "./codex-child-environment";

export interface CodexLineTransport {
	close(): Promise<void>;
	writeLine(value: object): void;
}

export type CodexLineHandlers = {
	onFailure(error: Error): void;
	onLine(line: string): void;
};

export type StartCodexStdioProcessOptions = {
	codexHomeDir: string;
	cwd: string;
};

class CodexProcessError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CodexProcessError";
	}
}

export function startCodexStdioProcess(
	options: StartCodexStdioProcessOptions,
	handlers: CodexLineHandlers,
): CodexLineTransport {
	const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
		cwd: options.cwd,
		env: createCodexChildEnvironment(process.env, options.codexHomeDir),
		stdio: ["pipe", "pipe", "pipe"],
	});

	return createCodexLineTransport(child, handlers);
}

function createCodexLineTransport(
	child: ChildProcessWithoutNullStreams,
	handlers: CodexLineHandlers,
): CodexLineTransport {
	const lineReader = readline.createInterface({ input: child.stdout });
	let closing = false;
	let failureReported = false;

	const reportFailure = (error: Error): void => {
		if (closing || failureReported) {
			return;
		}
		failureReported = true;
		handlers.onFailure(error);
	};

	lineReader.on("line", (line) => {
		handlers.onLine(line);
	});
	child.on("error", (error) => {
		reportFailure(new CodexProcessError("Codex app-server process failed.", { cause: error }));
	});
	child.on("exit", (code, signal) => {
		reportFailure(
			new CodexProcessError(
				`Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
			),
		);
	});
	child.stdin.on("error", (error) => {
		reportFailure(new CodexProcessError("Codex app-server stdin failed.", { cause: error }));
	});
	// stderr is diagnostic-only; draining it prevents the child from blocking on a full pipe.
	child.stderr.on("data", () => undefined);

	return {
		close: async () => {
			if (closing) {
				return;
			}
			closing = true;
			lineReader.close();
			if (child.exitCode != null || child.signalCode != null) {
				return;
			}

			const exitPromise = waitForExit(child);
			child.kill("SIGTERM");
			if (await exitsWithin(exitPromise, 1_000)) {
				return;
			}
			child.kill("SIGKILL");
			await exitsWithin(exitPromise, 1_000);
		},
		writeLine: (value) => {
			if (closing || child.stdin.destroyed) {
				throw new Error("Codex app-server transport is closed.");
			}
			child.stdin.write(`${JSON.stringify(value)}\n`);
		},
	};
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve) => {
		child.once("exit", () => {
			resolve();
		});
	});
}

async function exitsWithin(exitPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timeout: NodeJS.Timeout | undefined;
	const didExit = await Promise.race([
		exitPromise.then(() => true),
		new Promise<false>((resolve) => {
			timeout = setTimeout(() => resolve(false), timeoutMs);
		}),
	]);
	if (timeout !== undefined) {
		clearTimeout(timeout);
	}
	return didExit;
}
