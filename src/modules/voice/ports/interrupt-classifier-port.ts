// ルナの読み上げ中に聞こえた声を、止まって聞くべきかで分ける。
export type InterruptVerdict = "interruption" | "backchannel" | "not_to_luna";

export type InterruptQuestion = Readonly<{
	heard: string;
	// 声が重なった時にルナが読み上げていた文。
	lunaSaying: string;
}>;

export interface InterruptClassifierPort {
	// 判定できなければ例外で終わる。
	classify(question: InterruptQuestion, signal: AbortSignal): Promise<InterruptVerdict>;
}
