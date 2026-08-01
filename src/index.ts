import { startLunaApplication } from "./runtime/composition-root";

type LunaApplication = Awaited<ReturnType<typeof startLunaApplication>>;

let application: LunaApplication | undefined;
let stopRequested = false;
const startupAbortController = new AbortController();

async function stop(exitCode: number, fatal = false): Promise<void> {
  const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = Math.max(currentExitCode, exitCode);
  const runningApplication = application;
  if (runningApplication === undefined) {
    stopRequested = true;
    startupAbortController.abort();
    return;
  }
  await runningApplication.shutdown(fatal);
}

function handleSignal(): void {
  void stop(0).catch(() => {
    process.exitCode = 1;
  });
}

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

application = await startLunaApplication({ startupSignal: startupAbortController.signal }).catch(
  (error: unknown) => {
    if (stopRequested && startupAbortController.signal.aborted) return undefined;
    throw error;
  },
);
if (application !== undefined && stopRequested) {
  await stop(0);
} else if (application !== undefined) {
  void application.fatal
    .then(async () => await stop(1, true))
    .catch(() => {
      process.exitCode = 1;
    });
}
