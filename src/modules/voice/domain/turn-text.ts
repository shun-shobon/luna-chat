const ENDS_WITH_CLOSING = /[。．.！!？?…♪」』)）]$/u;
// 接続助詞・言いよどみで終わる文は、まだ続きを言う途中と見る。
// 「〜て」は「見て」「待って」のような頼みでも終わるため含めない。話の途中だった時は割り込みの判定で拾い直せる。
const ENDS_UNFINISHED =
	/(?:けど|けれど|けども|から|ので|のに|たり|だり|ながら|たら|なら|とか|(?:だ|です|ます|た)し|(?:だ|です|ます)が|を|、|,|えー|えっと|あの|その|まあ|なんか)$/u;

// 句読点のない文字起こしでも、文が途中で切れているように見えるかを文末の形で判定する。
export function looksUnfinished(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "" || ENDS_WITH_CLOSING.test(trimmed)) return false;
	return ENDS_UNFINISHED.test(trimmed);
}
