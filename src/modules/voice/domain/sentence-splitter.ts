// 文末の記号の後に閉じ括弧が続けば、それも同じ文に含める。
const SENTENCE_END = /[。．！!？?♪\n]+[」』）)]*/gu;
// 返事の最初の区切りだけは読点でも切る。一文を書き終えるのを待たずに読み上げを始めるため。
const FIRST_PIECE_END = /[。．！!？?♪\n]+[」』）)]*|[、，,]/gu;
const SPOKEN_CHAR = /[\p{L}\p{N}]/gu;
// Irodori-TTS は0.5秒に満たない読み上げを断る。「うん。」だけのような短い区切りは次とつなげて読ませる。
const MIN_SPOKEN_CHARS = 3;

// モデルが流す文字を、読み上げに回せる区切りずつに切る。
export class SentenceSplitter {
	#buffer = "";
	#emitted = false;

	push(delta: string): string[] {
		this.#buffer += delta;
		const pieces: string[] = [];
		for (let end = this.#nextEnd(); end !== undefined; end = this.#nextEnd()) {
			pieces.push(this.#buffer.slice(0, end).trim());
			this.#buffer = this.#buffer.slice(end);
			this.#emitted = true;
		}
		return pieces;
	}

	// 区切りの記号がないまま終わった残り。
	flush(): string | undefined {
		const rest = this.#buffer.trim();
		this.#buffer = "";
		return rest === "" ? undefined : rest;
	}

	#nextEnd(): number | undefined {
		for (const match of this.#buffer.matchAll(this.#emitted ? SENTENCE_END : FIRST_PIECE_END)) {
			const end = match.index + match[0].length;
			// 届いた文字の末尾で終わる記号の後には、「？」や閉じ括弧が続いて届くことがある。
			if (end === this.#buffer.length) return undefined;
			if (spokenChars(this.#buffer.slice(0, end)) >= MIN_SPOKEN_CHARS) return end;
		}
		return undefined;
	}
}

function spokenChars(text: string): number {
	return text.match(SPOKEN_CHAR)?.length ?? 0;
}
