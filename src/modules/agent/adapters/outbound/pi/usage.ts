import { z } from "zod";

import type { UsageSnapshot, UsageWindow } from "../../../ports/outbound/agent-session-port";
import type { ChatGptBackend } from "./chatgpt-backend";

// Codex の backend-client（rate_limit_snapshots_from_payload）と同じく、本体の枠を "codex" と呼ぶ。
const PRIMARY_LIMIT_ID = "codex";

const windowSchema = z.looseObject({
	used_percent: z.number(),
	limit_window_seconds: z.number().int().positive(),
	reset_at: z.number().int(),
});
const rateLimitSchema = z.looseObject({
	primary_window: windowSchema.nullish(),
	secondary_window: windowSchema.nullish(),
});
const usageResponseSchema = z.looseObject({
	plan_type: z.string(),
	rate_limit: rateLimitSchema.nullish(),
	additional_rate_limits: z
		.array(
			z.looseObject({
				limit_name: z.string(),
				metered_feature: z.string().min(1),
				rate_limit: rateLimitSchema.nullish(),
			}),
		)
		.nullish(),
});

export async function fetchUsage(
	backend: ChatGptBackend,
	signal: AbortSignal,
): Promise<UsageSnapshot> {
	const response = await backend.request({
		method: "GET",
		path: "wham/usage",
		schema: usageResponseSchema,
		signal,
	});
	return {
		fetchedAt: new Date().toISOString(),
		planType: response.plan_type,
		limits: [
			toLimit(PRIMARY_LIMIT_ID, response.rate_limit),
			...(response.additional_rate_limits ?? []).map((limit) =>
				toLimit(limit.metered_feature, limit.rate_limit),
			),
		],
	};
}

function toLimit(
	limitId: string,
	rateLimit: z.infer<typeof rateLimitSchema> | null | undefined,
): UsageSnapshot["limits"][number] {
	return {
		limitId,
		primary: toWindow(rateLimit?.primary_window),
		secondary: toWindow(rateLimit?.secondary_window),
	};
}

function toWindow(window: z.infer<typeof windowSchema> | null | undefined): UsageWindow | null {
	if (window == null) return null;
	return {
		usedPercent: window.used_percent,
		// Codex と同じく秒を分へ切り上げる。
		windowMinutes: Math.ceil(window.limit_window_seconds / 60),
		resetsAt: new Date(window.reset_at * 1000).toISOString(),
	};
}
