import { once } from "node:events";

import { createBot } from "mineflayer";
import type { Bot } from "mineflayer";
import pathfinderModule from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { z } from "zod";

import { ACTION_TIMEOUT_MS } from "../domain/action";
import type { MinecraftAction } from "../domain/action";
import {
	CRAFT_CANDIDATES,
	isEquippable,
	isFuel,
	isPlaceable,
	isSmeltable,
	SCAFFOLDING_BLOCKS,
} from "../domain/items";
import {
	FLEE_DISTANCE,
	judgeReflex,
	REFLEX_LIMIT_MS,
	THREAT_DISTANCE,
	WATER_ESCAPE_DISTANCE,
} from "../domain/reflex";
import type { ReflexTrigger } from "../domain/reflex";
import { blockPosition, isInterestingBlock, REACH_DISTANCE, SIGHT_DISTANCE } from "../domain/world";
import type { EntityKind, Vec3 as Position, WorldSnapshot } from "../domain/world";
import type { ActionOutcome, ObserveRequest } from "../ports/minecraft-connection-port";

const { goals, Movements, pathfinder } = pathfinderModule;

// prismarine-* は直接の依存ではないため、型は Mineflayer の Bot から取る。
type Block = NonNullable<ReturnType<Bot["blockAt"]>>;
type Entity = Bot["entity"];
type Item = ReturnType<Bot["inventory"]["items"]>[number];

const SPAWN_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 5_000;
// 経路探索で使う、落ちてよい高さ（SPEC §25.4）。
const MAX_DROP = 3;
const COMMON_BLOCKS: ReadonlySet<string> = new Set(["stone", "water", "sand", "gravel", "lava"]);
const FIND_COMMON_PER_KIND = 16;
const FIND_RARE_LIMIT = 256;
const VISIBLE_PER_KIND = 3;
// 行動中に新しい敵が出たかを確かめる間隔（tick）。見える判定は重いため毎tickは行わない。
const THREAT_CHECK_TICKS = 10;
const ATTACK_INTERVAL_MS = 650;
const DEATH_MESSAGE_WINDOW_MS = 2_000;
const SAFE_SEARCH_RADIUS = 6;

// Mineflayer が物理の計算で足すが、型には載っていない項目。外部の値なので読む時に検証する。
const entityPhysicsSchema = z.looseObject({
	isInWater: z.boolean().optional(),
	isInLava: z.boolean().optional(),
	eyeHeight: z.number(),
});
const burningFlagsSchema = z.number().int();
const oxygenSchema = z.number().optional();
const FULL_OXYGEN = 20;

export type PlayerEvents = Readonly<{
	reflexed(event: Readonly<{ trigger: ReflexTrigger; detail: string }>): void;
	died(
		event: Readonly<{
			message: string;
			position: Position;
			dimension: string;
			lostItems: Readonly<Record<string, number>>;
		}>,
	): void;
	disconnected(reason: string): void;
}>;

class ActionInterrupted extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "ActionInterrupted";
	}
}

// ワーカースレッドの中でMineflayerのボットを1つ持ち、観測・行動・反射を受け持つ。
export class MineflayerPlayer {
	readonly #bot: Bot;
	readonly #events: PlayerEvents;
	#action: AbortController | undefined;
	#closing = false;
	#lastDeathMessage: { text: string; at: number } | undefined;
	#reflex: ReflexTrigger | undefined;
	#reflexAbort: AbortController | undefined;
	#threatTick = 0;

	private constructor(bot: Bot, events: PlayerEvents) {
		this.#bot = bot;
		this.#events = events;
	}

	static async connect(
		settings: Readonly<{ host: string; port: number; username: string }>,
		events: PlayerEvents,
	): Promise<MineflayerPlayer> {
		const bot = createBot({
			host: settings.host,
			port: settings.port,
			username: settings.username,
			auth: "offline",
			hideErrors: true,
			logErrors: false,
			respawn: true,
		});
		bot.loadPlugin(pathfinder);
		const failed = Promise.withResolvers<never>();
		const fail = (reason: unknown): void => {
			failed.reject(new Error(`Could not join the Minecraft server: ${describe(reason)}`));
		};
		bot.once("error", fail);
		bot.once("kicked", fail);
		bot.once("end", fail);
		try {
			await Promise.race([
				once(bot, "spawn"),
				failed.promise,
				new Promise((_resolve, reject) => {
					setTimeout(
						() => reject(new Error("Timed out joining the Minecraft server")),
						SPAWN_TIMEOUT_MS,
					);
				}),
			]);
		} catch (error: unknown) {
			bot.end();
			throw error;
		} finally {
			bot.off("error", fail);
			bot.off("kicked", fail);
			bot.off("end", fail);
		}
		const player = new MineflayerPlayer(bot, events);
		player.#install();
		return player;
	}

	observe(request: ObserveRequest): WorldSnapshot {
		const bot = this.#bot;
		const self = bot.entity;
		const physics = entityPhysicsSchema.parse(self);
		const items = bot.inventory.items();
		const inventory = countItems(items);
		const targetBlocks = this.#blocksDropping(request.targetItems);
		const table = this.#nearestBlock("crafting_table", REACH_DISTANCE);
		return {
			self: {
				position: toPosition(self.position),
				dimension: bot.game.dimension.replace(/^minecraft:/u, ""),
				health: bot.health,
				food: bot.food,
				oxygen: this.#oxygen(),
				held: bot.heldItem?.name ?? null,
				armor: [5, 6, 7, 8].flatMap((slot) => {
					const name = bot.inventory.slots[slot]?.name;
					return name === undefined ? [] : [name];
				}),
				effects: Object.values(self.effects).flatMap((effect) => {
					const name = bot.registry.effects[effect.id]?.name;
					return name === undefined ? [] : [name];
				}),
				onGround: self.onGround,
				inWater: physics.isInWater ?? false,
				inLava: physics.isInLava ?? false,
				burning: this.#burning(),
			},
			inventory,
			world: {
				timeOfDay: bot.time.timeOfDay,
				raining: bot.isRaining,
				thundering: bot.thunderState > 0,
			},
			visibleEntities: this.#visibleEntities().map(({ entity, distance }) => ({
				id: entity.id,
				name: this.#entityName(entity),
				kind: this.#kindOf(entity),
				position: toPosition(entity.position),
				distance,
			})),
			visibleBlocks: this.#visibleBlocks(targetBlocks).map(({ block, distance }) => ({
				name: block.name,
				position: toPosition(block.position),
				distance,
				harvestable: this.#harvestable(block, items),
			})),
			verified: request.verify.flatMap((position) => {
				const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
				return block != null && this.#canSee(block) ? [{ position, block: block.name }] : [];
			}),
			craftable: this.#craftable(request.targetItems, table),
			foods: Object.keys(inventory).filter((name) => bot.registry.foodsByName[name] !== undefined),
			fuels: Object.keys(inventory).filter(isFuel),
			smeltable: Object.keys(inventory).filter(isSmeltable),
			equippable: Object.keys(inventory).filter(
				(name) =>
					isEquippable(name) &&
					name !== bot.heldItem?.name &&
					![5, 6, 7, 8].some((slot) => bot.inventory.slots[slot]?.name === name),
			),
			placeable: Object.keys(inventory).filter(isPlaceable),
			reflexActive: this.#reflex !== undefined,
		};
	}

	async execute(action: MinecraftAction, abort: AbortSignal): Promise<ActionOutcome> {
		if (this.#reflex !== undefined) {
			return { result: "interrupted", detail: `reflex ${this.#reflex} is running`, chest: null };
		}
		const local = new AbortController();
		this.#action = local;
		// 行動の前から見えていた敵は、行動中の「新しい敵」に数えない。
		this.#knownHostiles = this.#visibleHostileIds();
		const signal = AbortSignal.any([abort, local.signal]);
		// 反射が行動を中断した時は、始まった反射の入力を消さない。
		const release = (): void => {
			if (this.#reflex === undefined) this.#releaseInputs();
		};
		const onAbort = (): void => {
			release();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const health = this.#bot.health;
		const watch = (): void => {
			if (this.#bot.health < health) local.abort(new ActionInterrupted("took damage"));
		};
		this.#bot.on("health", watch);
		try {
			const outcome = await this.#run(action, signal);
			return signal.aborted ? interrupted(signal) : outcome;
		} catch (error: unknown) {
			if (signal.aborted) return interrupted(signal);
			return { result: "failed", detail: describe(error), chest: null };
		} finally {
			signal.removeEventListener("abort", onAbort);
			this.#bot.off("health", watch);
			if (this.#action === local) this.#action = undefined;
			release();
		}
	}

	unknownItems(names: readonly string[]): readonly string[] {
		return names.filter((name) => this.#bot.registry.itemsByName[name] === undefined);
	}

	async close(): Promise<void> {
		this.#closing = true;
		this.#action?.abort(new ActionInterrupted("closing"));
		this.#releaseInputs();
		const ended = once(this.#bot, "end");
		this.#bot.quit();
		await Promise.race([
			ended,
			new Promise((resolve) => {
				setTimeout(resolve, QUIT_TIMEOUT_MS);
			}),
		]);
	}

	#install(): void {
		const bot = this.#bot;
		const movements = new Movements(bot);
		movements.maxDropDown = MAX_DROP;
		movements.allowParkour = false;
		movements.canDig = true;
		movements.allow1by1towers = true;
		// 既定では水への落下に高さの上限がない。
		movements.infiniteLiquidDropdownDistance = false;
		movements.scafoldingBlocks = SCAFFOLDING_BLOCKS.flatMap((name) => {
			const item = bot.registry.itemsByName[name];
			return item === undefined ? [] : [item.id];
		});
		bot.pathfinder.setMovements(movements);
		bot.on("physicsTick", () => {
			this.#tick();
		});
		bot.on("messagestr", (message, position) => {
			if (position === "system" && message.includes(bot.username)) {
				this.#lastDeathMessage = { text: message, at: Date.now() };
			}
		});
		bot.on("death", () => {
			this.#onDeath();
		});
		bot.on("end", (reason) => {
			if (!this.#closing) this.#events.disconnected(`Disconnected: ${reason}`);
		});
		// 接続の失敗は error の後に end が来て切断として知らせる。リスナーがないと error でワーカーが落ちる。
		bot.on("error", () => {});
		bot.on("kicked", (reason) => {
			if (!this.#closing) this.#events.disconnected(`Kicked: ${describe(reason)}`);
		});
	}

	#tick(): void {
		if (this.#reflex !== undefined) return;
		this.#threatTick = (this.#threatTick + 1) % THREAT_CHECK_TICKS;
		const trigger = judgeReflex(this.#reflexState());
		if (trigger != null) {
			this.#action?.abort(new ActionInterrupted(`reflex ${trigger}`));
			void this.#runReflex(trigger);
			return;
		}
		if (this.#action !== undefined && this.#threatTick === 0 && this.#newHostileVisible()) {
			this.#action.abort(new ActionInterrupted("a new hostile came into sight"));
		}
	}

	#knownHostiles = new Set<number>();

	#visibleHostileIds(): Set<number> {
		return new Set(
			this.#visibleEntities(THREAT_DISTANCE)
				.filter(({ entity }) => this.#kindOf(entity) === "hostile")
				.map(({ entity }) => entity.id),
		);
	}

	#newHostileVisible(): boolean {
		const hostiles = this.#visibleHostileIds();
		const appeared = [...hostiles].some((id) => !this.#knownHostiles.has(id));
		this.#knownHostiles = hostiles;
		return appeared;
	}

	#reflexState() {
		const bot = this.#bot;
		const physics = entityPhysicsSchema.parse(bot.entity);
		const eye = bot.entity.position.offset(0, physics.eyeHeight, 0);
		const head = bot.blockAt(eye);
		return {
			inLava: physics.isInLava ?? false,
			burning: this.#burning(),
			inWater: physics.isInWater ?? false,
			headInWater: head?.name === "water",
			oxygen: this.#oxygen(),
			health: bot.health,
			food: bot.food,
			// 体力が低い時だけ見える判定をするため、ここでは近い敵の有無を見る。
			hostileVisible:
				bot.health <= 8 &&
				this.#visibleEntities(FLEE_DISTANCE).some(
					({ entity }) => this.#kindOf(entity) === "hostile",
				),
			hasFood: bot.inventory
				.items()
				.some((item) => bot.registry.foodsByName[item.name] !== undefined),
		};
	}

	async #runReflex(trigger: ReflexTrigger): Promise<void> {
		this.#reflex = trigger;
		const stopped = new AbortController();
		this.#reflexAbort = stopped;
		const limit = AbortSignal.any([AbortSignal.timeout(REFLEX_LIMIT_MS), stopped.signal]);
		let detail: string;
		try {
			detail = await this.#reflexAction(trigger, limit);
		} catch (error: unknown) {
			detail = `failed: ${describe(error)}`;
		} finally {
			this.#releaseInputs();
			this.#reflex = undefined;
			this.#reflexAbort = undefined;
		}
		if (!this.#closing) this.#events.reflexed({ trigger, detail });
	}

	async #reflexAction(trigger: ReflexTrigger, signal: AbortSignal): Promise<string> {
		const bot = this.#bot;
		const until = async (done: () => boolean): Promise<void> => {
			while (!done() && !signal.aborted && !this.#closing) {
				await once(bot, "physicsTick");
			}
		};
		switch (trigger) {
			case "lava_or_fire": {
				const water = this.#nearestBlock("water", WATER_ESCAPE_DISTANCE);
				const target = water?.position ?? this.#safeStandingSpot();
				if (target === undefined) return "no safe block in reach";
				bot.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z));
				await until(() => judgeReflex(this.#reflexState()) !== "lava_or_fire");
				bot.pathfinder.setGoal(null);
				return `moved toward ${water == null ? "a safe block" : "water"} at ${formatVec(target)}`;
			}
			case "drowning": {
				bot.setControlState("jump", true);
				await until(() => !this.#reflexState().headInWater);
				return "swam up to breathe";
			}
			case "low_health_threat": {
				const threat = this.#visibleEntities(FLEE_DISTANCE).find(
					({ entity }) => this.#kindOf(entity) === "hostile",
				)?.entity;
				if (threat === undefined) return "the threat was gone";
				const from = threat.position.clone();
				bot.setControlState("sprint", true);
				bot.pathfinder.setGoal(
					new goals.GoalInvert(new goals.GoalNear(from.x, from.y, from.z, FLEE_DISTANCE)),
				);
				await until(
					() =>
						bot.entity.position.distanceTo(from) >= FLEE_DISTANCE ||
						!this.#visibleEntities(FLEE_DISTANCE).some(({ entity }) => entity.id === threat.id),
				);
				bot.pathfinder.setGoal(null);
				return `ran from ${this.#entityName(threat)}`;
			}
			case "low_health_hungry": {
				const food = bot.inventory
					.items()
					.find((item) => bot.registry.foodsByName[item.name] !== undefined);
				if (food === undefined) return "no food";
				await bot.equip(food, "hand");
				await bot.consume();
				return `ate ${food.name}`;
			}
			default: {
				const unknownTrigger: never = trigger;
				throw new Error(`Unknown reflex: ${String(unknownTrigger)}`);
			}
		}
	}

	async #run(action: MinecraftAction, signal: AbortSignal): Promise<ActionOutcome> {
		const bot = this.#bot;
		const done = (detail: string): ActionOutcome => ({ result: "succeeded", detail, chest: null });
		switch (action.type) {
			case "move_to":
				await this.#goto(
					new goals.GoalNear(action.target.x, action.target.y, action.target.z, 1),
					signal,
				);
				return done(`reached ${action.label}`);
			case "explore":
				await this.#goto(new goals.GoalXZ(action.target.x, action.target.z), signal);
				return done(`explored ${action.direction}`);
			case "mine": {
				const block = this.#blockAt(action.position);
				if (block.name !== action.block) throw new Error(`the block is now ${block.name}`);
				const tool = bot.pathfinder.bestHarvestTool(block);
				if (tool != null) await bot.equip(tool, "hand");
				await this.#goto(new goals.GoalLookAtBlock(block.position, bot.world), signal);
				await bot.dig(block, true);
				return done(`mined ${block.name}`);
			}
			case "collect": {
				const entity = bot.entities[action.entityId];
				if (entity === undefined) throw new Error("the item is gone");
				await this.#goto(
					new goals.GoalBlock(
						Math.floor(entity.position.x),
						Math.floor(entity.position.y),
						Math.floor(entity.position.z),
					),
					signal,
				);
				return done("walked onto the item");
			}
			case "craft": {
				const item = this.#item(action.item);
				const table = action.table == null ? null : this.#blockAt(action.table);
				const recipe = bot.recipesFor(item.id, null, 1, table)[0];
				if (recipe === undefined)
					throw new Error(`no recipe for ${action.item} with the current inventory`);
				await bot.craft(recipe, 1, table ?? undefined);
				return done(`crafted ${action.item}`);
			}
			case "place": {
				const item = bot.inventory.items().find((entry) => entry.name === action.item);
				if (item === undefined) throw new Error(`no ${action.item} in the inventory`);
				const reference = this.#placementReference();
				if (reference === undefined) throw new Error("no free spot next to Luna");
				await bot.equip(item, "hand");
				await bot.placeBlock(reference, new Vec3(0, 1, 0));
				return done(`placed ${action.item}`);
			}
			case "smelt": {
				const furnace = await bot.openFurnace(this.#blockAt(action.furnace));
				try {
					if (action.operation === "take") {
						await furnace.takeOutput();
						return done("took the furnace output");
					}
					const item = this.#item(action.item ?? "");
					const count = countItems(bot.inventory.items())[item.name] ?? 0;
					if (action.operation === "input") await furnace.putInput(item.id, null, count);
					else await furnace.putFuel(item.id, null, count);
					return done(`put ${String(count)} ${item.name} as ${action.operation}`);
				} finally {
					await furnace.close();
				}
			}
			case "store":
			case "take": {
				const block = this.#blockAt(action.chest);
				const chest = await bot.openContainer(block);
				try {
					const item = this.#item(action.item);
					if (action.type === "store") await chest.deposit(item.id, null, action.count);
					else await chest.withdraw(item.id, null, action.count);
					return {
						result: "succeeded",
						detail: `${action.type === "store" ? "stored" : "took"} ${String(action.count)} ${action.item}`,
						chest: { position: action.chest, items: countItems(chest.containerItems()) },
					};
				} finally {
					await chest.close();
				}
			}
			case "equip": {
				const item = bot.inventory.items().find((entry) => entry.name === action.item);
				if (item === undefined) throw new Error(`no ${action.item} in the inventory`);
				await bot.equip(item, equipDestination(action.item));
				return done(`equipped ${action.item}`);
			}
			case "eat": {
				const item = bot.inventory.items().find((entry) => entry.name === action.item);
				if (item === undefined) throw new Error(`no ${action.item} in the inventory`);
				await bot.equip(item, "hand");
				await bot.consume();
				return done(`ate ${action.item}`);
			}
			case "sleep":
				await bot.sleep(this.#blockAt(action.bed));
				return done("went to bed");
			case "attack": {
				const deadline = Date.now() + ACTION_TIMEOUT_MS.attack;
				while (!signal.aborted && Date.now() < deadline) {
					const target = bot.entities[action.entityId];
					if (target === undefined || !target.isValid) return done("the target is gone");
					if (bot.entity.position.distanceTo(target.position) > 3) {
						bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
					} else {
						bot.pathfinder.setGoal(null);
						await bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
						bot.attack(target);
					}
					await sleep(ATTACK_INTERVAL_MS);
				}
				return done("kept attacking");
			}
			case "retreat":
				await this.#goto(
					new goals.GoalInvert(
						new goals.GoalNear(action.from.x, action.from.y, action.from.z, FLEE_DISTANCE),
					),
					signal,
				);
				return done("moved away");
			case "wait":
				await sleep(ACTION_TIMEOUT_MS.wait);
				return done("waited");
			default: {
				const unknownAction: never = action;
				throw new Error(`Unknown Minecraft action: ${JSON.stringify(unknownAction)}`);
			}
		}
	}

	async #goto(goal: InstanceType<typeof goals.Goal>, signal: AbortSignal): Promise<void> {
		const stop = (): void => {
			this.#bot.pathfinder.setGoal(null);
		};
		// goto は経路が見つからず1歩も動けない時も成功として返すため、最後の経路の結果を見て失敗にする。
		let status: string | undefined;
		const onPath = (path: Readonly<{ status: string }>): void => {
			status = path.status;
		};
		signal.addEventListener("abort", stop, { once: true });
		this.#bot.on("path_update", onPath);
		try {
			await this.#bot.pathfinder.goto(goal);
		} finally {
			signal.removeEventListener("abort", stop);
			this.#bot.off("path_update", onPath);
		}
		if (!signal.aborted && status === "noPath") throw new Error("no path to the destination");
	}

	#onDeath(): void {
		const bot = this.#bot;
		const position = toPosition(bot.entity.position);
		const dimension = bot.game.dimension.replace(/^minecraft:/u, "");
		const lostItems = countItems(bot.inventory.items());
		const recent = this.#lastDeathMessage;
		const message =
			recent !== undefined && Date.now() - recent.at <= DEATH_MESSAGE_WINDOW_MS
				? recent.text
				: "Luna died";
		this.#action?.abort(new ActionInterrupted("died"));
		// 死んだら逃げる理由もなくなるため、走っている反射も止める。
		this.#reflexAbort?.abort();
		void once(bot, "spawn").then(() => {
			if (!this.#closing) this.#events.died({ message, position, dimension, lostItems });
		});
	}

	// pathfinder.stop() は止める予約の印を残し、動いていない時に呼ぶと次の setGoal（goto）を即座に止めてしまう。
	// 目標を外す setGoal(null) なら印を残さずに経路を捨てられる。
	#releaseInputs(): void {
		const bot = this.#bot;
		bot.pathfinder.setGoal(null);
		bot.stopDigging();
		bot.clearControlStates();
		if (bot.usingHeldItem) bot.deactivateItem();
	}

	#visibleEntities(
		range: number = SIGHT_DISTANCE,
	): readonly Readonly<{ entity: Entity; distance: number }>[] {
		const bot = this.#bot;
		const eye = this.#eye();
		return Object.values(bot.entities)
			.filter((entity) => entity !== bot.entity)
			.map((entity) => ({ entity, distance: entity.position.distanceTo(bot.entity.position) }))
			.filter(({ distance }) => distance <= range)
			.filter(({ entity }) =>
				[
					entity.position.offset(0, entity.height / 2, 0),
					entity.position.offset(0, entity.height * 0.9, 0),
				].some((point) => this.#clearLine(eye, point)),
			)
			.toSorted((left, right) => left.distance - right.distance);
	}

	// 観測と候補は種類ごとに近い3件しか使わないため、近い順に見える判定をして、3件見えた種類は飛ばす。
	#visibleBlocks(
		targetBlocks: ReadonlySet<string>,
	): readonly Readonly<{ block: Block; distance: number }>[] {
		const bot = this.#bot;
		// まとめて探すと足元の石や海の水だけで件数の上限が埋まるため、ありふれたブロックは種類ごとに少しだけ探し、
		// 残り（原木・鉱石・作業台など）はまとめて探す。種類ごとに全部探すと1回の観測が1秒を超えた。
		const interesting = bot.registry.blocksArray.filter(
			(block) => isInterestingBlock(block.name) || targetBlocks.has(block.name),
		);
		const common = interesting.filter((block) => COMMON_BLOCKS.has(block.name));
		const rare = interesting
			.filter((block) => !COMMON_BLOCKS.has(block.name))
			.map((block) => block.id);
		const found = [
			...common.flatMap((block) =>
				bot.findBlocks({
					matching: block.id,
					maxDistance: SIGHT_DISTANCE,
					count: FIND_COMMON_PER_KIND,
				}),
			),
			...bot.findBlocks({ matching: rare, maxDistance: SIGHT_DISTANCE, count: FIND_RARE_LIMIT }),
		]
			.map((position) => ({
				position,
				distance: position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position),
			}))
			.toSorted((left, right) => left.distance - right.distance);
		const perKind = new Map<string, number>();
		const visible: Array<Readonly<{ block: Block; distance: number }>> = [];
		for (const { position, distance } of found) {
			const block = bot.blockAt(position);
			if (block == null) continue;
			const count = perKind.get(block.name) ?? 0;
			if (count >= VISIBLE_PER_KIND || !this.#canSee(block)) continue;
			perKind.set(block.name, count + 1);
			visible.push({ block, distance });
		}
		return visible;
	}

	// 目の位置からブロックが遮られずに見えるか（SPEC §25.3）。Mineflayer の canSeeBlock（中心への光線）を使う。
	// world.raycast を matcher なしで呼ぶと、遮るブロックがあっても null を返すことがあったため自前では引かない。
	#canSee(block: Block): boolean {
		const eye = this.#eye();
		const center = block.position.offset(0.5, 0.5, 0.5);
		if (center.distanceTo(eye) > SIGHT_DISTANCE) return false;
		// 水と溶岩は当たり判定の形を持たず canSeeBlock の光線が通り抜けるため、間を遮るブロックだけを見る。
		if (block.name === "water" || block.name === "lava") return this.#clearLine(eye, center);
		return this.#bot.canSeeBlock(block);
	}

	// from から to までに、光を通さない完全なブロックがないか。通るマスを順にたどる（Amanatides & Woo の方法）。
	#clearLine(from: Vec3, to: Vec3): boolean {
		const axes = [axisWalk(from.x, to.x), axisWalk(from.y, to.y), axisWalk(from.z, to.z)] as const;
		const end = to.floored();
		const cell = from.floored();
		for (let visited = 0; visited < SIGHT_DISTANCE * 3; visited += 1) {
			if (cell.equals(end)) return true;
			const [alongX, alongY, alongZ] = axes;
			const nearest =
				alongX.next <= alongY.next && alongX.next <= alongZ.next
					? alongX
					: alongY.next <= alongZ.next
						? alongY
						: alongZ;
			if (nearest.next > 1) return true;
			if (nearest === alongX) cell.x += alongX.step;
			else if (nearest === alongY) cell.y += alongY.step;
			else cell.z += alongZ.step;
			nearest.next += nearest.delta;
			const block = this.#bot.blockAt(cell);
			if (block?.boundingBox === "block" && !block.transparent) return false;
		}
		return true;
	}

	#eye(): Vec3 {
		const physics = entityPhysicsSchema.parse(this.#bot.entity);
		return this.#bot.entity.position.offset(0, physics.eyeHeight, 0);
	}

	// サーバーは空気の量が既定（満タン）の間はメタデータを送らず、その間 Mineflayer の oxygenLevel は未定義のまま。
	#oxygen(): number {
		const level = oxygenSchema.parse(this.#bot.oxygenLevel);
		return level ?? FULL_OXYGEN;
	}

	#burning(): boolean {
		const flags = burningFlagsSchema.safeParse(this.#bot.entity.metadata[0]);
		return flags.success && (flags.data & 0x01) !== 0;
	}

	#kindOf(entity: Entity): EntityKind {
		const type: string = entity.type;
		if (type === "player") return "player";
		if (entity.name === "item") return "item";
		if (type === "hostile") return "hostile";
		if (["animal", "passive", "water_creature", "ambient"].includes(type)) return "passive";
		const category =
			(entity.name === undefined
				? undefined
				: this.#bot.registry.entitiesByName[entity.name]?.category) ?? "";
		if (category.includes("Hostile")) return "hostile";
		if (category.includes("Passive")) return "passive";
		return "other";
	}

	#entityName(entity: Entity): string {
		if (entity.name === "item") return entity.getDroppedItem()?.name ?? "item";
		return entity.username ?? entity.name ?? "unknown";
	}

	#harvestable(block: Block, items: readonly Item[]): boolean {
		if (!block.diggable || block.name === "water" || block.name === "lava") return false;
		const tools = block.harvestTools;
		return tools === undefined || items.some((item) => tools[String(item.type)] ?? false);
	}

	#craftable(targetItems: readonly string[], table: Block | null): WorldSnapshot["craftable"] {
		const bot = this.#bot;
		return [...new Set([...targetItems, ...CRAFT_CANDIDATES])].flatMap(
			(name): WorldSnapshot["craftable"] => {
				const item = bot.registry.itemsByName[name];
				if (item === undefined) return [];
				if (bot.recipesFor(item.id, null, 1, null).length > 0)
					return [{ item: name, needsTable: false }];
				if (table != null && bot.recipesFor(item.id, null, 1, table).length > 0) {
					return [{ item: name, needsTable: true }];
				}
				return [];
			},
		);
	}

	#blocksDropping(items: readonly string[]): ReadonlySet<string> {
		const registry = this.#bot.registry;
		const ids = new Set(
			items.flatMap((name) => {
				const item = registry.itemsByName[name];
				return item === undefined ? [] : [item.id];
			}),
		);
		return new Set(
			registry.blocksArray
				.filter((block) => block.drops.some((drop) => typeof drop === "number" && ids.has(drop)))
				.map((block) => block.name),
		);
	}

	#nearestBlock(name: string, range: number): Block | null {
		const block = this.#bot.registry.blocksByName[name];
		if (block === undefined) return null;
		return this.#bot.findBlock({ matching: block.id, maxDistance: range });
	}

	#safeStandingSpot(): Position | undefined {
		const bot = this.#bot;
		const origin = blockPosition(toPosition(bot.entity.position));
		const spots: Position[] = [];
		for (let dx = -SAFE_SEARCH_RADIUS; dx <= SAFE_SEARCH_RADIUS; dx += 1) {
			for (let dy = -2; dy <= 2; dy += 1) {
				for (let dz = -SAFE_SEARCH_RADIUS; dz <= SAFE_SEARCH_RADIUS; dz += 1) {
					const feet = new Vec3(origin.x + dx, origin.y + dy, origin.z + dz);
					const below = bot.blockAt(feet.offset(0, -1, 0));
					const body = bot.blockAt(feet);
					const head = bot.blockAt(feet.offset(0, 1, 0));
					if (
						below?.boundingBox !== "block" ||
						below.name === "lava" ||
						below.name === "magma_block"
					)
						continue;
					if (body?.boundingBox !== "empty" || head?.boundingBox !== "empty") continue;
					if ([body.name, head.name].some((name) => name === "lava" || name === "fire")) continue;
					spots.push(toPosition(feet));
				}
			}
		}
		return spots.toSorted(
			(left, right) =>
				new Vec3(left.x, left.y, left.z).distanceTo(bot.entity.position) -
				new Vec3(right.x, right.y, right.z).distanceTo(bot.entity.position),
		)[0];
	}

	// そばに置く時の土台。自分の足元を避け、上が空いている隣のブロックを選ぶ。
	#placementReference(): Block | undefined {
		const bot = this.#bot;
		const origin = blockPosition(toPosition(bot.entity.position));
		for (const [dx, dz] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
			[1, 1],
			[-1, -1],
			[1, -1],
			[-1, 1],
		] as const) {
			const ground = bot.blockAt(new Vec3(origin.x + dx, origin.y - 1, origin.z + dz));
			const above = bot.blockAt(new Vec3(origin.x + dx, origin.y, origin.z + dz));
			if (ground?.boundingBox === "block" && above?.boundingBox === "empty") return ground;
		}
		return undefined;
	}

	#blockAt(position: Position): Block {
		const block = this.#bot.blockAt(new Vec3(position.x, position.y, position.z));
		if (block == null) throw new Error(`the block at ${formatVec(position)} is not loaded`);
		return block;
	}

	#item(name: string): Readonly<{ id: number; name: string }> {
		const item = this.#bot.registry.itemsByName[name];
		if (item === undefined) throw new Error(`unknown item ${name}`);
		return item;
	}
}

function countItems(items: readonly Item[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count;
	return counts;
}

function equipDestination(item: string): "hand" | "head" | "torso" | "legs" | "feet" | "off-hand" {
	if (item.endsWith("_helmet")) return "head";
	if (item.endsWith("_chestplate")) return "torso";
	if (item.endsWith("_leggings")) return "legs";
	if (item.endsWith("_boots")) return "feet";
	if (item === "shield") return "off-hand";
	return "hand";
}

function interrupted(signal: AbortSignal): ActionOutcome {
	const reason: unknown = signal.reason;
	return {
		result: "interrupted",
		detail: reason instanceof ActionInterrupted ? reason.message : "aborted",
		chest: null,
	};
}

function toPosition(position: Vec3): Position {
	return { x: position.x, y: position.y, z: position.z };
}

function formatVec(position: Position): string {
	return `(${String(Math.floor(position.x))}, ${String(Math.floor(position.y))}, ${String(Math.floor(position.z))})`;
}

function describe(value: unknown): string {
	if (value instanceof Error) return value.message;
	return typeof value === "string" ? value : JSON.stringify(value);
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

// 線分を0〜1でたどる時の、1つの軸の進み方。next は次のマスの境界に着く位置、delta は1マス進むのにかかる長さ。
function axisWalk(from: number, to: number): { step: number; next: number; delta: number } {
	const length = to - from;
	if (length === 0)
		return { step: 0, next: Number.POSITIVE_INFINITY, delta: Number.POSITIVE_INFINITY };
	const step = Math.sign(length);
	const cell = Math.floor(from);
	const boundary = step > 0 ? cell + 1 : cell;
	return { step, next: (boundary - from) / length, delta: Math.abs(1 / length) };
}
