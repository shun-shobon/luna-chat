import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

export type StdioProcessOptions = {
  command: readonly [string, ...string[]];
  codexHomeDir: string;
  cwd: string;
};

export type StdioProcessHandle = {
  close: () => void;
  onError: (handler: (error: Error) => void) => void;
  onExit: (handler: () => void) => void;
  onLine: (handler: (line: string) => void) => void;
  writeLine: (message: object) => void;
};

export function startStdioProcess(options: StdioProcessOptions): StdioProcessHandle {
  const [command, ...args] = options.command;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      CODEX_HOME: options.codexHomeDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lineReader = readline.createInterface({
    input: child.stdout,
  });

  return createHandle(child, lineReader);
}

function createHandle(
  child: ChildProcessWithoutNullStreams,
  lineReader: readline.Interface,
): StdioProcessHandle {
  return {
    close: () => {
      lineReader.close();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000);
    },
    onError: (handler) => {
      child.on("error", handler);
    },
    onExit: (handler) => {
      child.on("exit", handler);
    },
    onLine: (handler) => {
      lineReader.on("line", handler);
    },
    writeLine: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
  };
}
