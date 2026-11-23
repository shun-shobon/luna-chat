import { z } from "zod";

// Claude Code の rate_limit_event.rate_limit_info のうち、ここで頼る項目だけ。
export const rateLimitInfoSchema = z.looseObject({
	status: z.string().nullish(),
	rateLimitType: z.string().nullish(),
	resetsAt: z.number().nullish(),
	isUsingOverage: z.boolean().nullish(),
	overageStatus: z.string().nullish(),
	overageDisabledReason: z.string().nullish(),
});
export type RateLimitInfo = z.infer<typeof rateLimitInfoSchema>;

// Anthropic がサードパーティ扱いにした要求を断るときの文言（your の無い言い回しも上流の issue #53 で報告されている）。自前の文言には必ず "billing" を入れ、再試行させない。
const USAGE_CREDITS_REJECTION =
	/third-party apps now draw from (?:your )?extra usage|out of extra usage|draws? from your usage credits/iu;

export function usageCreditsChargeError(info: RateLimitInfo | undefined): Error | undefined {
	if (info === undefined || !(info.isUsingOverage ?? false)) return undefined;
	const type =
		info.rateLimitType != null && info.rateLimitType !== "" ? `, ${info.rateLimitType}` : "";
	return new Error(
		"Claude Code billing: this request was charged to Claude usage credits instead of your plan limits " +
			`(rate limit status ${info.status ?? "unknown"}${type}). ` +
			"luna stopped so further requests are not charged. To stay on plan limits only, turn off usage credits at " +
			"claude.ai/settings/usage.",
	);
}

export function describeUsageCreditsRejection(message: string): string | undefined {
	if (!USAGE_CREDITS_REJECTION.test(message)) return undefined;
	return (
		"Claude Code billing: Anthropic did not accept this request on your Claude plan limits and wants to charge " +
		"it to usage credits. This happens when your plan limit is used up, or when Anthropic classifies the " +
		"request as third-party app usage. luna will not retry it. Original error: " +
		message
	);
}
