import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { parse } from "smol-toml";
import { z } from "zod";

import { writeFileAtomicSync } from "../../../shared/atomic-file";
import { hasErrorCode } from "../../../shared/error-code";
import type { IntentFireStates, StandingIntent } from "../domain/standing-intent";
import type { IntentStorePort } from "../ports/intent-store-port";

// 既定値は docs/SPEC.md の intents.toml の節で定めたもの。
const DEFAULT_COOLDOWN_HOURS = 24;
const DEFAULT_MAX_FIRES = 3;

const nonBlank = z.string().refine((value) => value.trim().length > 0, "must not be blank");

const intentsFileSchema = z
	.strictObject({
		intents: z
			.array(
				z.strictObject({
					id: nonBlank,
					keywords: z.array(nonBlank).min(1),
					action: nonBlank,
					expires_at: z.iso.datetime({ offset: true }),
					cooldown_hours: z.number().nonnegative().default(DEFAULT_COOLDOWN_HOURS),
					max_fires: z.number().int().positive().default(DEFAULT_MAX_FIRES),
				}),
			)
			.default([]),
	})
	.superRefine((file, context) => {
		const ids = new Set<string>();
		for (const [index, intent] of file.intents.entries()) {
			if (ids.has(intent.id)) {
				context.addIssue({
					code: "custom",
					message: `intent id must be unique: ${intent.id}`,
					path: ["intents", index, "id"],
				});
			}
			ids.add(intent.id);
		}
	});

const statesSchema = z.record(
	z.string(),
	z.strictObject({ fires: z.number().int().nonnegative(), lastFiredAt: z.iso.datetime() }),
);

export class IntentFileStore implements IntentStorePort {
	constructor(
		private readonly intentsPath: string,
		private readonly statePath: string,
	) {}

	readIntents(): readonly StandingIntent[] {
		const source = readOptional(this.intentsPath);
		if (source === undefined) return [];
		const file = intentsFileSchema.parse(parse(source));
		return file.intents.map((intent) => ({
			id: intent.id,
			keywords: intent.keywords,
			action: intent.action,
			expiresAt: new Date(intent.expires_at),
			cooldownHours: intent.cooldown_hours,
			maxFires: intent.max_fires,
		}));
	}

	readStates(): IntentFireStates {
		const source = readOptional(this.statePath);
		return source === undefined ? {} : statesSchema.parse(JSON.parse(source));
	}

	writeStates(states: IntentFireStates): void {
		mkdirSync(dirname(this.statePath), { recursive: true });
		writeFileAtomicSync(this.statePath, `${JSON.stringify(states, null, "\t")}\n`);
	}
}

function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error: unknown) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}
