import type { JsonObject } from "../../../shared/json";
import { SerialQueue } from "../../../shared/serial-queue";
import type { LoggerPort } from "../../observability/ports/logger-port";
import type { ActivityHandle, ToolExecution } from "../../tool/domain/tool";
import { actionTimeoutMs, describeAction, listCandidates } from "../domain/action";
import type { MinecraftAction } from "../domain/action";
import { createMinecraftEvent, MINECRAFT_EVENT_KIND, minecraftEventJson } from "../domain/event";
import type { MinecraftEvent, MinecraftEventType } from "../domain/event";
import { changedDuringInference, GoalTracker, targetsMet } from "../domain/goal";
import type { GoalAnswer, GoalVerdict, MinecraftGoal } from "../domain/goal";
import type { MinecraftStatus } from "../domain/minecraft-status";
import { buildObservation, goalStatusJson } from "../domain/observation";
import type { ActionRecord, ReflexRecord } from "../domain/observation";
import { THREAT_DISTANCE } from "../domain/reflex";
import { blockPosition, formatPosition } from "../domain/world";
import type { Vec3, WorldSnapshot } from "../domain/world";
import {
	findNamedPlace,
	nameRememberedPlace,
	positionsToVerify,
	rememberChest,
	rememberDeath,
	rememberSnapshot,
} from "../domain/world-memory";
import type { WorldMemory } from "../domain/world-memory";
import type { DecisionModelPort } from "../ports/decision-model-port";
import type {
	ConnectionListener,
	MinecraftConnection,
	MinecraftConnector,
} from "../ports/minecraft-connection-port";
import type { WorldMemoryStorePort } from "../ports/world-memory-store-port";

const RECENT_LIMIT = 20;
// 反射の間は判断しないため、終わるのを待つ間隔。
const REFLEX_POLL_MS = 250;
// 判断や行動の思わぬ失敗が続いても、ループを詰めて回さないための間隔。
const FAILURE_BACKOFF_MS = 1_000;
const RECONNECT_DELAYS_MS: readonly number[] = [5_000, 10_000, 30_000, 60_000];
// 同じ反射が前の終わりからこの間に再び終わったら、続いている1つの反射として計画役を起こさない。
// 体力が低いまま敵が見え隠れすると、逃げる反射が数秒おきに繰り返して計画役を起こし続けた。
const REFLEX_MERGE_MS = 30_000;

type Cancel = () => void;

export type MinecraftPlayDependencies = Readonly<{
	connect: MinecraftConnector;
	decisions: DecisionModelPort;
	memory: WorldMemoryStorePort;
	logger: LoggerPort;
	now: () => Date;
	schedule: (callback: () => void, milliseconds: number) => Cancel;
	settings: Readonly<{ world: string; decisionTimeoutMs: number; plannerIntervalMs: number }>;
}>;

export type GoalInput = Readonly<{
	objective: string;
	targets: Readonly<Record<string, number>>;
	waypoint: Vec3 | string | null;
}>;

type Play = {
	readonly ownerId: string;
	readonly taskId: string;
	readonly abort: AbortController;
	readonly tracker: GoalTracker;
	handle: ActivityHandle | undefined;
	connection: MinecraftConnection | undefined;
	memory: WorldMemory;
	goal: MinecraftGoal | null;
	goalAnswer: GoalAnswer | null;
	// 目標の状態を通知した後は、新しい目標が来るまで判断しない。
	halted: boolean;
	recentActions: ActionRecord[];
	recentEvents: MinecraftEvent[];
	lastReflex: ReflexRecord | null;
	lastReflexEndedMs: number | null;
	lastDecisionMs: number | null;
	lastSnapshot: WorldSnapshot | undefined;
	cancelInterval: Cancel | undefined;
	cancelReconnect: Cancel | undefined;
	wake: (() => void) | undefined;
	loop: Promise<void> | undefined;
	ended: Promise<void> | undefined;
};

class MinecraftError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MinecraftError";
	}
}

// Minecraftのプレイを1つだけ持ち、計画役のツール・1手の判断・出来事をつなぐ（docs/minecraft.md）。
export class MinecraftPlayService {
	readonly #saves = new SerialQueue();
	#play: Play | undefined;
	#starting: Promise<Play> | undefined;

	constructor(private readonly dependencies: MinecraftPlayDependencies) {}

	async setGoal(
		execution: ToolExecution,
		input: GoalInput,
	): Promise<Readonly<{ accepted_at: string }>> {
		const play = await this.#ensure(execution);
		const connection = requireConnection(play);
		const unknown = await connection.unknownItems(Object.keys(input.targets));
		if (unknown.length > 0) throw new MinecraftError(`Unknown item names: ${unknown.join(", ")}`);
		const waypoint = this.#resolveWaypoint(play, input.waypoint);
		play.goal = { objective: input.objective, targets: { ...input.targets }, waypoint };
		play.goalAnswer = null;
		play.halted = false;
		play.tracker.reset();
		this.#armInterval(play);
		play.wake?.();
		return { accepted_at: this.#timestamp() };
	}

	async observe(execution: ToolExecution): Promise<JsonObject> {
		const play = await this.#ensure(execution);
		const connection = requireConnection(play);
		const snapshot = await this.#observe(play, connection);
		const custom = await connection.customActions();
		this.#armInterval(play);
		return {
			...this.#observationOf(play, snapshot),
			goal_status: goalStatusJson(play.goalAnswer),
			recent_events: play.recentEvents.map(minecraftEventJson),
			custom_actions: {
				loaded: [...custom.loaded],
				candidates: custom.candidates.map((candidate) => candidate.description),
				errors: custom.errors.map((entry) => ({ name: entry.name, error: entry.error })),
			},
		};
	}

	async namePlace(
		execution: ToolExecution,
		input: Readonly<{ name: string; position: Vec3 | null }>,
	): Promise<Readonly<{ name: string; position: Vec3 }>> {
		const play = await this.#ensure(execution);
		const snapshot = await this.#observe(play, requireConnection(play));
		const position = input.position ?? blockPosition(snapshot.self.position);
		this.#updateMemory(
			play,
			nameRememberedPlace(play.memory, {
				name: input.name,
				position,
				dimension: snapshot.self.dimension,
				seenAt: this.#timestamp(),
			}),
		);
		this.#armInterval(play);
		return { name: input.name, position };
	}

	snapshot(): MinecraftStatus {
		const play = this.#play;
		return {
			taskId: play?.taskId ?? null,
			connection:
				play === undefined ? "idle" : play.connection === undefined ? "reconnecting" : "connected",
			world: this.dependencies.settings.world,
			goal: play?.goal ?? null,
			goalStatus: play?.goalAnswer ?? null,
			recentActions: [...(play?.recentActions ?? [])],
			recentEvents: [...(play?.recentEvents ?? [])],
			lastDecisionMs: play?.lastDecisionMs ?? null,
		};
	}

	// シャットダウン用。セッションを閉じるとプレイも終わるが、ワーカーが残らないよう直接も止める。
	async stop(): Promise<void> {
		const play = this.#play;
		if (play === undefined) return;
		play.handle?.end();
		await this.#end(play);
	}

	async #ensure(execution: ToolExecution): Promise<Play> {
		const origin = execution.origin;
		if (origin.kind !== "task") {
			throw new MinecraftError("Minecraft tools are only for the minecraft worker");
		}
		// 同じ応答のツール呼び出しは並行に来るため、await より前に開始中のプレイを1つに決める。
		if (this.#play === undefined && this.#starting === undefined) {
			this.#starting = this.#start(execution.ownerId, origin.taskId, execution).finally(() => {
				this.#starting = undefined;
			});
		}
		const play = this.#play ?? (await this.#starting);
		if (play === undefined) throw new MinecraftError("Minecraft play could not start");
		if (play.ownerId !== execution.ownerId) {
			throw new MinecraftError(`Minecraft is being played by task ${play.taskId}`);
		}
		return play;
	}

	async #start(ownerId: string, taskId: string, execution: ToolExecution): Promise<Play> {
		const memory = await this.dependencies.memory.load();
		const play: Play = {
			ownerId,
			taskId,
			abort: new AbortController(),
			tracker: new GoalTracker(),
			handle: undefined,
			connection: undefined,
			memory,
			goal: null,
			goalAnswer: null,
			halted: false,
			recentActions: [],
			recentEvents: [],
			lastReflex: null,
			lastReflexEndedMs: null,
			lastDecisionMs: null,
			lastSnapshot: undefined,
			cancelInterval: undefined,
			cancelReconnect: undefined,
			wake: undefined,
			loop: undefined,
			ended: undefined,
		};
		play.connection = await this.dependencies.connect(this.#listenerFor(play));
		play.handle = execution.activities.begin(async () => await this.#end(play));
		this.#play = play;
		this.#logger(play).info("minecraft.play_started", { world: this.dependencies.settings.world });
		play.loop = this.#runLoop(play);
		this.#armInterval(play);
		return play;
	}

	async #end(play: Play): Promise<void> {
		play.ended ??= (async () => {
			play.abort.abort();
			play.cancelInterval?.();
			play.cancelReconnect?.();
			play.wake?.();
			try {
				await play.loop;
				await play.connection?.close();
			} catch (error: unknown) {
				this.#logger(play).warn("minecraft.close_failed", { error });
			} finally {
				play.connection = undefined;
				// 切断に失敗しても次のタスクが遊べるよう、プレイは必ず外す。
				if (this.#play === play) this.#play = undefined;
			}
			await this.#saves.run(async () => {});
			this.#logger(play).info("minecraft.play_ended");
		})();
		await play.ended;
	}

	#listenerFor(play: Play): ConnectionListener {
		return {
			reflexed: (event) => {
				const now = this.dependencies.now().getTime();
				const continuing =
					play.lastReflex?.trigger === event.trigger &&
					play.lastReflexEndedMs != null &&
					now - play.lastReflexEndedMs <= REFLEX_MERGE_MS;
				play.lastReflex = { trigger: event.trigger, at: this.#timestamp() };
				play.lastReflexEndedMs = now;
				if (continuing) return;
				void this.#emitWithObservation(play, "reflex", `${event.trigger}: ${event.detail}`);
			},
			died: (event) => {
				this.#updateMemory(
					play,
					rememberDeath(play.memory, {
						position: event.position,
						dimension: event.dimension,
						at: this.#timestamp(),
						message: event.message,
						lostItems: { ...event.lostItems },
					}),
				);
				const lost = Object.entries(event.lostItems)
					.map(([item, count]) => `${String(count)} ${item}`)
					.join(", ");
				void this.#emitWithObservation(
					play,
					"death",
					`${event.message} at ${formatPosition(event.position)} in ${event.dimension}; lost: ${lost === "" ? "nothing" : lost}`,
				);
			},
			disconnected: (reason) => {
				if (isEnded(play)) return;
				play.connection = undefined;
				this.#emit(play, "disconnected", reason, null);
				this.#reconnect(play, 0);
			},
		};
	}

	#reconnect(play: Play, attempt: number): void {
		const delays = RECONNECT_DELAYS_MS;
		const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
		play.cancelReconnect = this.dependencies.schedule(() => {
			void this.dependencies.connect(this.#listenerFor(play)).then(
				async (connection) => {
					if (isEnded(play)) {
						await connection.close();
						return;
					}
					play.connection = connection;
					this.#logger(play).info("minecraft.reconnected", { attempt: attempt + 1 });
					play.wake?.();
				},
				(error: unknown) => {
					this.#logger(play).warn("minecraft.reconnect_failed", { attempt: attempt + 1, error });
					if (!isEnded(play)) this.#reconnect(play, attempt + 1);
				},
			);
		}, delay);
	}

	async #runLoop(play: Play): Promise<void> {
		while (!isEnded(play)) {
			const connection = play.connection;
			const goal = play.goal;
			if (connection === undefined || goal == null || play.halted) {
				await this.#sleep(play);
				continue;
			}
			try {
				await this.#step(play, connection, goal);
			} catch (error: unknown) {
				if (isEnded(play)) return;
				this.#logger(play).warn("minecraft.step_failed", { error });
				// 切断で失敗した手は数えない。切断中は判断を止め、再接続してから続ける（docs/minecraft.md の「接続とプレイの期間」）。
				if (play.connection === connection) this.#judge(play, goal, play.tracker.acted(false));
				await this.#delay(play, FAILURE_BACKOFF_MS);
			}
		}
	}

	async #step(play: Play, connection: MinecraftConnection, goal: MinecraftGoal): Promise<void> {
		const before = await this.#observe(play, connection);
		if (before.reflexActive) {
			await this.#delay(play, REFLEX_POLL_MS);
			return;
		}
		// 決定モデルは達成の確率を控えめに返し、集め終えても 0.8 に届かないことがあったため、数で確かめられる目標はここで決める。
		if (targetsMet(goal, before.inventory)) {
			this.#complete(play, goal);
			return;
		}
		const custom = await connection.customActions();
		const candidates = listCandidates({
			snapshot: before,
			memory: play.memory,
			goal,
			custom: custom.candidates,
		});
		const started = this.dependencies.now().getTime();
		let decision;
		try {
			decision = await this.dependencies.decisions.decide(
				{
					state: this.#observationOf(play, before),
					candidates: candidates.map((candidate) => candidate.description),
				},
				AbortSignal.any([
					play.abort.signal,
					AbortSignal.timeout(this.dependencies.settings.decisionTimeoutMs),
				]),
			);
		} catch (error: unknown) {
			if (isEnded(play)) return;
			this.#logger(play).warn("minecraft.decision_failed", { error });
			this.#judge(play, goal, play.tracker.acted(false));
			return;
		}
		play.lastDecisionMs = this.dependencies.now().getTime() - started;
		const candidate = candidates[decision.choice];
		this.#logger(play).info("minecraft.decision", {
			candidates: candidates.length,
			action: candidate === undefined ? null : describeAction(candidate.action),
			goalStatus: decision.goal.status,
			goalProbability: decision.goal.probability,
			latencyMs: play.lastDecisionMs,
		});
		// 推論の間に新しい目標が来たら、古い目標への答えは使わない。
		if (play.goal !== goal || isEnded(play)) return;
		const after = await this.#observe(play, connection);
		if (changedDuringInference(inferenceView(before), inferenceView(after))) {
			this.#judge(play, goal, play.tracker.discarded());
			return;
		}
		play.goalAnswer = decision.goal;
		const verdict = play.tracker.answered(decision.goal);
		if (verdict != null) {
			this.#judge(play, goal, verdict);
			return;
		}
		if (candidate === undefined) {
			throw new MinecraftError(`Decision chose no candidate: ${String(decision.choice)}`);
		}
		await this.#act(play, connection, goal, candidate.action);
	}

	async #act(
		play: Play,
		connection: MinecraftConnection,
		goal: MinecraftGoal,
		action: MinecraftAction,
	): Promise<void> {
		const started = this.dependencies.now().getTime();
		const timeout = AbortSignal.timeout(actionTimeoutMs(action));
		const outcome = await connection.execute(action, AbortSignal.any([play.abort.signal, timeout]));
		const timedOut = timeout.aborted && !isEnded(play);
		const result = timedOut ? "failed" : outcome.result;
		const detail = timedOut ? `timed out: ${outcome.detail}` : outcome.detail;
		const record: ActionRecord = {
			action: describeAction(action),
			result,
			detail,
			at: this.#timestamp(),
		};
		play.recentActions = [...play.recentActions, record].slice(-RECENT_LIMIT);
		this.#logger(play).info("minecraft.action", {
			action: record.action,
			result,
			durationMs: this.dependencies.now().getTime() - started,
		});
		if (outcome.chest != null && play.lastSnapshot !== undefined) {
			this.#updateMemory(
				play,
				rememberChest(play.memory, {
					position: outcome.chest.position,
					dimension: play.lastSnapshot.self.dimension,
					items: outcome.chest.items,
					seenAt: record.at,
				}),
			);
		}
		// 被弾や敵の出現による中断は、選んだ行動の失敗とは数えない。
		if (result !== "interrupted")
			this.#judge(play, goal, play.tracker.acted(result === "succeeded"));
	}

	#complete(play: Play, goal: MinecraftGoal): void {
		if (play.goal !== goal) return;
		play.halted = true;
		const targets = Object.entries(goal.targets)
			.map(([item, count]) => `${String(count)} ${item}`)
			.join(", ");
		void this.#emitWithObservation(
			play,
			"goal_done",
			`The inventory has every target: ${targets}.`,
		);
	}

	// 判断や行動の間に新しい目標が来ていたら、古い目標の結果では止めない。
	#judge(play: Play, goal: MinecraftGoal, verdict: GoalVerdict): void {
		if (verdict == null || play.goal !== goal) return;
		play.halted = true;
		const answer = goalStatusJson(play.goalAnswer);
		void this.#emitWithObservation(
			play,
			verdict,
			verdict === "goal_done"
				? "The decision model judged the goal done."
				: `The decision model could not advance the goal (last answer: ${JSON.stringify(answer)}).`,
		);
	}

	async #emitWithObservation(play: Play, type: MinecraftEventType, detail: string): Promise<void> {
		const connection = play.connection;
		let observation: JsonObject | null = null;
		if (connection !== undefined) {
			try {
				observation = this.#observationOf(play, await this.#observe(play, connection));
			} catch (error: unknown) {
				this.#logger(play).warn("minecraft.observe_failed", { error });
			}
		}
		if (!isEnded(play)) this.#emit(play, type, detail, observation);
	}

	#emit(
		play: Play,
		type: MinecraftEventType,
		detail: string,
		observation: JsonObject | null,
	): void {
		const event = createMinecraftEvent({ type, at: this.#timestamp(), detail, observation });
		play.recentEvents = [...play.recentEvents, event].slice(-RECENT_LIMIT);
		play.handle?.notify(
			{ kind: MINECRAFT_EVENT_KIND, text: JSON.stringify(minecraftEventJson(event)) },
			{ urgent: event.urgent, replaceKey: type },
		);
		this.#logger(play).info("minecraft.event", { type, urgent: event.urgent, detail });
		this.#armInterval(play);
	}

	#armInterval(play: Play): void {
		play.cancelInterval?.();
		play.cancelInterval = this.dependencies.schedule(() => {
			if (isEnded(play)) return;
			void this.#emitWithObservation(play, "interval", "Periodic check-in.");
		}, this.dependencies.settings.plannerIntervalMs);
	}

	async #observe(play: Play, connection: MinecraftConnection): Promise<WorldSnapshot> {
		const position = play.lastSnapshot?.self.position;
		const dimension = play.lastSnapshot?.self.dimension;
		const snapshot = await connection.observe({
			targetItems: Object.keys(play.goal?.targets ?? {}),
			verify:
				position === undefined || dimension === undefined
					? []
					: positionsToVerify(play.memory, position, dimension),
		});
		play.lastSnapshot = snapshot;
		this.#updateMemory(play, rememberSnapshot(play.memory, snapshot, this.#timestamp()));
		return snapshot;
	}

	#observationOf(play: Play, snapshot: WorldSnapshot): JsonObject {
		return buildObservation({
			snapshot,
			memory: play.memory,
			goal: play.goal,
			recentActions: play.recentActions,
			lastReflex: play.lastReflex,
		});
	}

	#updateMemory(play: Play, memory: WorldMemory): void {
		if (JSON.stringify(memory) === JSON.stringify(play.memory)) return;
		play.memory = memory;
		void this.#saves
			.run(async () => await this.dependencies.memory.save(play.memory))
			.catch((error: unknown) => {
				this.#logger(play).error("minecraft.memory_save_failed", { error });
			});
	}

	#resolveWaypoint(play: Play, waypoint: GoalInput["waypoint"]): Vec3 | null {
		if (waypoint == null || typeof waypoint !== "string") return waypoint;
		const place = findNamedPlace(play.memory, waypoint);
		if (place === undefined) throw new MinecraftError(`Unknown place name: ${waypoint}`);
		return place.position;
	}

	async #sleep(play: Play): Promise<void> {
		const woken = Promise.withResolvers<void>();
		play.wake = () => woken.resolve();
		await woken.promise;
		play.wake = undefined;
	}

	async #delay(play: Play, milliseconds: number): Promise<void> {
		const done = Promise.withResolvers<void>();
		const cancel = this.dependencies.schedule(() => done.resolve(), milliseconds);
		const onAbort = (): void => {
			cancel();
			done.resolve();
		};
		play.abort.signal.addEventListener("abort", onAbort, { once: true });
		await done.promise;
		play.abort.signal.removeEventListener("abort", onAbort);
	}

	#logger(play: Play): LoggerPort {
		return this.dependencies.logger.child({ taskId: play.taskId });
	}

	#timestamp(): string {
		return this.dependencies.now().toISOString();
	}
}

function requireConnection(play: Play): MinecraftConnection {
	if (play.connection === undefined) {
		throw new MinecraftError("Not connected to the Minecraft server; reconnecting");
	}
	return play.connection;
}

function inferenceView(snapshot: WorldSnapshot) {
	return {
		position: snapshot.self.position,
		health: snapshot.self.health,
		hostileIds: snapshot.visibleEntities
			.filter((entity) => entity.kind === "hostile" && entity.distance <= THREAT_DISTANCE)
			.map((entity) => entity.id),
	};
}

// 終わりは別の非同期処理（セッションの停止）から来るため、await をまたぐ判定は毎回ここで読み直す。
function isEnded(play: Play): boolean {
	return play.abort.signal.aborted;
}
