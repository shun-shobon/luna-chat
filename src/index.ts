#!/usr/bin/env node
import { resolve } from "node:path";

import { defineCommand, runMain } from "citty";

import { startLunaApplication } from "./runtime/composition-root";
import { runLogin } from "./runtime/login";
import { parseReplayVariants, runReplayCommand } from "./runtime/replay";

type LunaApplication = Awaited<ReturnType<typeof startLunaApplication>>;

let application: LunaApplication | undefined;
const startupAbortController = new AbortController();

async function stop(exitCode: number): Promise<void> {
	const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
	process.exitCode = Math.max(currentExitCode, exitCode);
	if (application === undefined) {
		startupAbortController.abort();
		return;
	}
	await application.shutdown();
}

function handleSignal(): void {
	void stop(0).catch(() => {
		process.exitCode = 1;
	});
}

process.once("SIGINT", handleSignal);
process.once("SIGTERM", handleSignal);

const start = defineCommand({
	meta: { name: "start", description: "Start the Discord bot (default)." },
	async run() {
		// runMain は失敗時に process.exit するため、標準出力のログを流し切れるよう自分で終了コードを付ける。
		try {
			application = await startLunaApplication({
				startupSignal: startupAbortController.signal,
				// src/index.ts と dist/index.mjs のどちらから起動しても同じ階層にある。
				templatesDir: resolve(import.meta.dirname, "../templates"),
			});
		} catch (error: unknown) {
			if (startupAbortController.signal.aborted) return;
			console.error(error);
			process.exitCode = 1;
		}
	},
});

const login = defineCommand({
	meta: { name: "login", description: "Log in to ChatGPT with a device code." },
	async run() {
		await runLogin(startupAbortController.signal);
	},
});

const replay = defineCommand({
	meta: { name: "replay", description: "Replay recorded inputs with different instructions." },
	args: {
		scenes: { type: "string", required: true, description: "Scene file (JSON)." },
		out: { type: "string", required: true, description: "Output directory." },
		variant: {
			type: "positional",
			required: true,
			valueHint: "name=dir",
			description: "Instruction directories to compare (one or more).",
		},
	},
	async run({ args }) {
		await runReplayCommand({
			scenesPath: args.scenes,
			outDir: args.out,
			variants: parseReplayVariants(args._),
		});
	},
});

await runMain(
	defineCommand({
		meta: { name: "luna-chat", description: "Luna, a Discord bot powered by an AI agent." },
		subCommands: { start, login, replay },
		default: "start",
	}),
);
