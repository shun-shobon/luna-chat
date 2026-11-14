export type StandingIntent = Readonly<{
	id: string;
	keywords: readonly string[];
	action: string;
	expiresAt: Date;
	cooldownHours: number;
	maxFires: number;
}>;

type IntentFireState = Readonly<{ fires: number; lastFiredAt: string }>;

export type IntentFireStates = Readonly<Record<string, IntentFireState>>;

export type IntentMatch = Readonly<{ intent: StandingIntent; keyword: string }>;

const HOUR_MS = 60 * 60 * 1000;

// 全角半角や大文字小文字の違いで取りこぼさないよう、比べる前に揃える。
function normalizeForMatch(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

export function findFiringIntents(input: {
	intents: readonly StandingIntent[];
	states: IntentFireStates;
	text: string;
	now: Date;
}): readonly IntentMatch[] {
	const text = normalizeForMatch(input.text);
	return input.intents.flatMap((intent) => {
		if (!isActive(intent, input.states[intent.id], input.now)) return [];
		const keyword = intent.keywords.find((candidate) =>
			text.includes(normalizeForMatch(candidate)),
		);
		return keyword === undefined ? [] : [{ intent, keyword }];
	});
}

function isActive(intent: StandingIntent, state: IntentFireState | undefined, now: Date): boolean {
	if (now.getTime() >= intent.expiresAt.getTime()) return false;
	if (state === undefined) return true;
	if (state.fires >= intent.maxFires) return false;
	return now.getTime() - Date.parse(state.lastFiredAt) >= intent.cooldownHours * HOUR_MS;
}
