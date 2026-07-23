import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import * as readline from "node:readline";

import { createCodexChildEnvironment, resolveCodexExecutable } from "./codex-executable";

export interface CodexLineTransport {
  close(): Promise<void>;
  onFailure(handler: (error: Error) => void): () => void;
  onLine(handler: (line: string) => void): () => void;
  writeLine(value: object): void;
}

export type StartCodexStdioProcessOptions = {
  codexHomeDir: string;
  cwd: string;
  executablePath?: string;
  parentEnvironment?: NodeJS.ProcessEnv;
};

class CodexProcessError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexProcessError";
  }
}

export function startCodexStdioProcess(options: StartCodexStdioProcessOptions): CodexLineTransport {
  const executablePath = options.executablePath ?? resolveCodexExecutable();
  if (!isAbsolute(executablePath)) {
    throw new Error("Codex executable path must be absolute.");
  }
  const child = spawn(executablePath, ["app-server", "--listen", "stdio://"], {
    cwd: options.cwd,
    env: createCodexChildEnvironment(
      options.parentEnvironment ?? process.env,
      options.codexHomeDir,
    ),
    stdio: ["pipe", "pipe", "pipe"],
  });

  return createCodexLineTransport(child);
}

function createCodexLineTransport(child: ChildProcessWithoutNullStreams): CodexLineTransport {
  const lineReader = readline.createInterface({ input: child.stdout });
  const failureHandlers = new Set<(error: Error) => void>();
  const lineHandlers = new Set<(line: string) => void>();
  let closing = false;
  let failureReported = false;

  const reportFailure = (error: Error): void => {
    if (closing || failureReported) {
      return;
    }
    failureReported = true;
    for (const handler of failureHandlers) {
      handler(error);
    }
  };

  lineReader.on("line", (line) => {
    for (const handler of lineHandlers) {
      handler(line);
    }
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
      if (child.exitCode !== null || child.signalCode !== null) {
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
    onFailure: (handler) => {
      failureHandlers.add(handler);
      return () => failureHandlers.delete(handler);
    },
    onLine: (handler) => {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
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
  return new Promise((resolve) => child.once("exit", () => resolve()));
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
