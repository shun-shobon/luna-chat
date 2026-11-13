import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoggerPort } from "../../../../observability/ports/logger-port";
import type { UsageSnapshot } from "../../../ports/outbound/agent-session-port";

type UsagePollerInput = Readonly<{
	fetch: (signal: AbortSignal) => Promise<UsageSnapshot>;
	filePath: string;
	intervalMs: number;
	logger: LoggerPort;
	onUsage: (usage: UsageSnapshot) => void;
}>;

// 使用枠を定期的に取得し、ダッシュボードとワークスペースのスクリプトから読める場所へ書き出す。
export class UsagePoller {
	readonly #controller = new AbortController();
	#timer: NodeJS.Timeout | undefined;
	#running: Promise<void> | undefined;

	constructor(private readonly input: UsagePollerInput) {}

	start(): void {
		this.#tick();
	}

	async stop(): Promise<void> {
		this.#controller.abort();
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#running;
	}

	#tick(): void {
		if (this.#controller.signal.aborted) return;
		this.#running = this.#poll().finally(() => {
			if (this.#controller.signal.aborted) return;
			this.#timer = setTimeout(() => this.#tick(), this.input.intervalMs);
		});
	}

	async #poll(): Promise<void> {
		try {
			const usage = await this.input.fetch(this.#controller.signal);
			this.input.onUsage(usage);
			await writeAtomically(this.input.filePath, `${JSON.stringify(usage, null, 2)}\n`);
		} catch (error: unknown) {
			if (this.#controller.signal.aborted) return;
			this.input.logger.log("warn", "agent.usage_fetch_failed", {}, { error });
		}
	}
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, content, "utf8");
	await rename(temporaryPath, filePath);
}
