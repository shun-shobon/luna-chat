import type { CustomCandidate, MinecraftAction } from "../domain/action";
import type { ReflexTrigger } from "../domain/reflex";
import type { Vec3, WorldSnapshot } from "../domain/world";

export type ObserveRequest = Readonly<{
	// 目標の targets のアイテム名。それを落とすブロックも見える対象にする。
	targetItems: readonly string[];
	// 記憶した位置。見えたら、そこにある今のブロックを返させる。
	verify: readonly Vec3[];
}>;

export type ActionOutcome = Readonly<{
	result: "succeeded" | "failed" | "interrupted";
	detail: string;
	// store / take で開けたチェストの、閉じる前の中身。
	chest: Readonly<{ position: Vec3; items: Readonly<Record<string, number>> }> | null;
}>;

// エージェントが足した行動の状態（docs/minecraft.md の「エージェントが足す行動」）。
export type CustomActionsReport = Readonly<{
	loaded: readonly string[];
	candidates: readonly CustomCandidate[];
	errors: readonly Readonly<{ name: string; error: string }>[];
}>;

export type ConnectionListener = Readonly<{
	// 反射が終わった時に呼ぶ。
	reflexed(event: Readonly<{ trigger: ReflexTrigger; detail: string }>): void;
	// 死んで復活した時に呼ぶ。
	died(
		event: Readonly<{
			message: string;
			position: Vec3;
			dimension: string;
			lostItems: Readonly<Record<string, number>>;
		}>,
	): void;
	// サーバーから切断された時に一度だけ呼ぶ。close で閉じた時は呼ばない。
	disconnected(reason: string): void;
}>;

export interface MinecraftConnection {
	observe(request: ObserveRequest): Promise<WorldSnapshot>;
	// signal で中断したら、入力を離して interrupted を返す。
	execute(action: MinecraftAction, signal: AbortSignal): Promise<ActionOutcome>;
	// サーバーの版のアイテムにない名前を返す。
	unknownItems(names: readonly string[]): Promise<readonly string[]>;
	// エージェントが足した行動を読み直し、今の候補を返す。
	customActions(): Promise<CustomActionsReport>;
	close(): Promise<void>;
}

export type MinecraftConnector = (listener: ConnectionListener) => Promise<MinecraftConnection>;
