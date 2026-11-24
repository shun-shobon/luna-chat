import type { JsonObject } from "../../../shared/json";

// 読み上げ中に聞こえ、割り込みと判定しなかった声の扱い。
export type AsideKind = "backchannel" | "not_to_luna";

// 音声モードの会話記録。表と裏の両方が読む。
export type VoiceRecordEntry =
	| Readonly<{
			kind: "heard";
			at: Date;
			userId: string;
			speaker: string;
			text: string;
			aside: AsideKind | null;
	  }>
	| Readonly<{
			kind: "said";
			at: Date;
			// 再生し終えた文、再生の途中で止めた文、再生しなかった文。
			played: readonly string[];
			cut: string | null;
			dropped: readonly string[];
	  }>
	| Readonly<{ kind: "delegated"; at: Date; request: string }>
	| Readonly<{ kind: "report"; at: Date; text: string }>;

// 長く話し続けてもメモリを使い切らないよう、古いものから捨てる。
const MAX_ENTRIES = 300;

export class VoiceRecord {
	#entries: VoiceRecordEntry[] = [];
	// 捨てた分も含めた通し番号で、まだ裏へ渡していない位置を指す。
	#firstSeq = 0;

	get endSeq(): number {
		return this.#firstSeq + this.#entries.length;
	}

	add(entry: VoiceRecordEntry): void {
		this.#entries.push(entry);
		const overflow = this.#entries.length - MAX_ENTRIES;
		if (overflow > 0) {
			this.#entries.splice(0, overflow);
			this.#firstSeq += overflow;
		}
	}

	recent(limit: number): readonly VoiceRecordEntry[] {
		return limit <= 0 ? [] : this.#entries.slice(-limit);
	}

	since(seq: number): readonly VoiceRecordEntry[] {
		return this.#entries.slice(Math.max(0, seq - this.#firstSeq));
	}
}

export function formatRecordLine(entry: VoiceRecordEntry): string {
	const time = formatTime(entry.at);
	if (entry.kind === "heard") {
		const note =
			entry.aside === "backchannel"
				? " (while you were speaking, a backchannel)"
				: entry.aside === "not_to_luna"
					? " (while you were speaking, not to you)"
					: "";
		return `[${time}] ${entry.speaker}${note}: ${entry.text}`;
	}
	if (entry.kind === "said") {
		const parts = [entry.played.join("")];
		if (entry.cut != null) parts.push(`[cut off while saying: ${entry.cut}]`);
		if (entry.dropped.length > 0) parts.push(`[did not get to say: ${entry.dropped.join("")}]`);
		return `[${time}] You: ${parts.filter((part) => part !== "").join(" ")}`;
	}
	if (entry.kind === "delegated")
		return `[${time}] You asked your backstage self: ${entry.request}`;
	return `[${time}] Backstage report: ${entry.text}`;
}

export function toRecordJson(entry: VoiceRecordEntry): JsonObject {
	const at = entry.at.toISOString();
	if (entry.kind === "heard") {
		return {
			at,
			type: "heard",
			user_id: entry.userId,
			speaker: entry.speaker,
			text: entry.text,
			...(entry.aside == null ? {} : { aside: entry.aside }),
		};
	}
	if (entry.kind === "said") {
		return {
			at,
			type: "said",
			played: [...entry.played],
			cut: entry.cut,
			dropped: [...entry.dropped],
		};
	}
	if (entry.kind === "delegated") return { at, type: "delegated", request: entry.request };
	return { at, type: "report", text: entry.text };
}

function formatTime(at: Date): string {
	return [at.getHours(), at.getMinutes(), at.getSeconds()]
		.map((value) => String(value).padStart(2, "0"))
		.join(":");
}
