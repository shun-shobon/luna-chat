import type { MinecraftEvent } from "./event";
import type { GoalAnswer, MinecraftGoal } from "./goal";
import type { ActionRecord } from "./observation";

// ダッシュボードに出す、Minecraftのプレイの今の状態。
export type MinecraftStatus = Readonly<{
	taskId: string | null;
	connection: "idle" | "connected" | "reconnecting";
	world: string;
	goal: MinecraftGoal | null;
	goalStatus: GoalAnswer | null;
	recentActions: readonly ActionRecord[];
	recentEvents: readonly MinecraftEvent[];
	lastDecisionMs: number | null;
}>;
