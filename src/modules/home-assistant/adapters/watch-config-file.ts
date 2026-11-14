import { readFileSync, statSync } from "node:fs";

import { parse } from "smol-toml";
import { z } from "zod";

import { hasErrorCode } from "../../../shared/error-code";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { WatchConfigState } from "../domain/home-assistant-status";
import type { WatchConfigPort } from "../ports/watch-config-port";

// 既定値は docs/SPEC.md の home-assistant.toml の節で定めたもの。
const DEFAULT_COOLDOWN_SECONDS = 30;

const nonBlank = z.string().refine((value) => value.trim().length > 0, "must not be blank");

const watchFileSchema = z.strictObject({
	watch: z.array(nonBlank).default([]),
	ignore: z.array(nonBlank).default([]),
	cooldown_seconds: z.number().nonnegative().default(DEFAULT_COOLDOWN_SECONDS),
});

type Cached = Readonly<{ modifiedAtMs: number | undefined; state: WatchConfigState }>;

// state_changed はセンサーの数だけ頻繁に届くため、更新時刻が変わった時だけ読み直す。
export class WatchConfigFile implements WatchConfigPort {
	#cached: Cached | undefined;

	constructor(
		private readonly path: string,
		private readonly logger: LoggerPort,
	) {}

	read(): WatchConfigState {
		const modifiedAtMs = this.#modifiedAtMs();
		if (this.#cached !== undefined && this.#cached.modifiedAtMs === modifiedAtMs) {
			return this.#cached.state;
		}
		const state = modifiedAtMs === undefined ? { status: "missing" as const } : this.#load();
		this.#cached = { modifiedAtMs, state };
		return state;
	}

	#modifiedAtMs(): number | undefined {
		try {
			return statSync(this.path).mtimeMs;
		} catch (error: unknown) {
			if (hasErrorCode(error, "ENOENT")) return undefined;
			throw error;
		}
	}

	#load(): WatchConfigState {
		try {
			const file = watchFileSchema.parse(parse(readFileSync(this.path, "utf8")));
			return {
				status: "valid",
				config: {
					watch: file.watch,
					ignore: file.ignore,
					cooldownSeconds: file.cooldown_seconds,
				},
			};
		} catch (error: unknown) {
			this.logger.error("home_assistant.watch_config_invalid", { error, path: this.path });
			const message =
				error instanceof z.ZodError
					? z.prettifyError(error)
					: error instanceof Error
						? error.message
						: String(error);
			return { status: "invalid", error: message };
		}
	}
}
