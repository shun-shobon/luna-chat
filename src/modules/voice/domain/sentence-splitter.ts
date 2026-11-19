// 文末の記号の後に閉じ括弧が続けば、それも同じ文に含める。
const BOUNDARY = /[。．！!？?♪\n]+[」』）)]*/u;

// モデルが流す文字を、読み上げに回せる一文ずつに切る。
export class SentenceSplitter {
	#buffer = "";

	push(delta: string): string[] {
		this.#buffer += delta;
		const sentences: string[] = [];
		for (
			let match = BOUNDARY.exec(this.#buffer);
			match != null;
			match = BOUNDARY.exec(this.#buffer)
		) {
			const end = match.index + match[0].length;
			// 届いた文字の末尾で終わる記号の後には、「？」や閉じ括弧が続いて届くことがある。
			if (end === this.#buffer.length) break;
			const sentence = this.#buffer.slice(0, end).trim();
			this.#buffer = this.#buffer.slice(end);
			if (sentence !== "") sentences.push(sentence);
		}
		return sentences;
	}

	// 文末の記号がないまま終わった残り。
	flush(): string | undefined {
		const rest = this.#buffer.trim();
		this.#buffer = "";
		return rest === "" ? undefined : rest;
	}
}
