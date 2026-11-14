// 渡された処理を1つずつ順に実行する。失敗は呼び出し元へ返し、後続の処理は止めない。
export class SerialQueue {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.catch(() => undefined);
		return result;
	}
}
