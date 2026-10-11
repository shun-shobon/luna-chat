import { startLunaApplication } from "./runtime/composition-root";

type LunaApplication = Awaited<ReturnType<typeof startLunaApplication>>;

let application: LunaApplication | undefined;
const startupAbortController = new AbortController();

async function stop(exitCode: number, fatal = false): Promise<void> {
	const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
	process.exitCode = Math.max(currentExitCode, exitCode);
	if (application === undefined) {
		startupAbortController.abort();
		return;
	}
	await application.shutdown(fatal);
}

function handleSignal(): void {
	void stop(0).catch(() => {
		process.exitCode = 1;
	});
}

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

async function start(): Promise<void> {
	application = await startLunaApplication({ startupSignal: startupAbortController.signal }).catch(
		(error: unknown) => {
			if (startupAbortController.signal.aborted) return undefined;
			throw error;
		},
	);
	void application?.fatal
		.then(async () => await stop(1, true))
		.catch(() => {
			process.exitCode = 1;
		});
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- SEA 用に CJS へバンドルするためトップレベル await を使えない
void start().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
