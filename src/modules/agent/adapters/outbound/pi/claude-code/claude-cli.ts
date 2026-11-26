import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { z } from "zod";

import { usageCreditsChargeError } from "./billing";
import type { RateLimitInfo } from "./billing";
import { INERT_MCP_SCRIPT } from "./inert-mcp";
import { isRecord, nativeUsageSchema, parseNativeOutputEvent } from "./native-types";
import type {
	AnthropicStreamEvent,
	NativeFrame,
	NativeMessage,
	NativeOutputEvent,
	NativeResult,
	NativeUsage,
} from "./native-types";
import type { NativeSystemInjection, ToolManifestEntry } from "./transcript";
import { TurnRelay } from "./turn-relay";

const CLAUDE_COMMAND = "claude";
const INSTALL_HINT = "Claude Code is not installed. Install it so that `claude` is on PATH.";
const LOGIN_HINT =
	"Claude Code is installed but not logged in. Run `claude auth login` and try again.";

type Env = Record<string, string | undefined>;

type ClaudeStatus = {
	available: boolean;
	loggedIn: boolean;
	// Claude Pro/Max のようなサブスクでログインしている。
	subscription: boolean;
	authMethod?: string;
	plan?: string;
	detail?: string;
	command?: string;
	// claude auth status を起動できなかった、JSON を返さなかった、または読めない JSON だった。本当のログアウトでは立たない。
	diagnostic?: boolean;
};

type RunClaudeInput = {
	model: string;
	// Claude に見せる作業ディレクトリ。
	cwd?: string;
	frames: NativeFrame[];
	systemPrompt: string;
	manifest: ToolManifestEntry[];
	extraBody: Record<string, unknown>;
	signal?: AbortSignal;
	timeoutMs?: number;
	env?: Env;
	upstreamUrl?: string;
	// Claude Code がその user メッセージの直後に差し込んだ system メッセージ。
	initialSystemMessages?: unknown[];
	// 過去の assistant の境界へ戻す system/ツールの差分。
	nativeSystemInjections?: NativeSystemInjection[];
	// リレーが Claude Code 自身のヘッダーへ足す beta。
	betas?: string[];
	onEvent?: (event: AnthropicStreamEvent) => void;
	// 直線的な続きなら温まったプロセスを使い回せるセッション。
	sessionId?: string;
};

type RunClaudeOutput = {
	message: NativeMessage;
	result: NativeResult;
	usage: NativeUsage;
	exitCode: number;
	relay: {
		upstreamRequests: number;
		blockedRequests: number;
		requestId?: string;
	};
	initialSystemMessages?: unknown[];
	rateLimit?: RateLimitInfo;
};

async function executable(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveClaudeExecutable(env: Env): Promise<string | undefined> {
	for (const directory of (env["PATH"] ?? "").split(delimiter)) {
		if (directory === "") continue;
		const candidate = join(directory, CLAUDE_COMMAND);
		if (await executable(candidate)) return candidate;
	}
	return undefined;
}

function claudeEnvironment(env: Env): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && key !== "ANTHROPIC_API_KEY") output[key] = value;
	}
	return output;
}

async function captureProcess(
	command: string,
	args: string[],
	env: Record<string, string>,
	signal?: AbortSignal,
	timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
	signal?.throwIfAborted();
	const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout = (stdout + chunk).slice(-1_000_000);
	});
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-65_536);
	});

	const abort = () => {
		killProcessTree(child);
	};
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	try {
		const code = await childExit(child);
		signal?.throwIfAborted();
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

function outputTail(text: string, limit = 500): string {
	const trimmed = text.trim();
	return trimmed.length > limit ? `...${trimmed.slice(-limit)}` : trimmed;
}

const authStatusSchema = z.looseObject({
	loggedIn: z.boolean().optional(),
	subscriptionType: z.string().nullish(),
	authMethod: z.string().nullish(),
});
type AuthStatus = z.infer<typeof authStatusSchema>;

// 先頭に JSON 以外の出力が混ざることがある。
function statusPayload(stdout: string): AuthStatus | undefined {
	const text = stdout.trim();
	if (text === "") return undefined;
	const candidates = [text];
	const brace = text.indexOf("{");
	if (brace > 0) candidates.push(text.slice(brace));
	for (const candidate of candidates) {
		try {
			const parsed = authStatusSchema.safeParse(JSON.parse(candidate));
			if (parsed.success) return parsed.data;
		} catch {
			// 次の候補を試す。失敗は呼び出し側が報告する。
		}
	}
	return undefined;
}

export async function getClaudeStatus(
	envInput: Env = process.env,
	signal?: AbortSignal,
): Promise<ClaudeStatus> {
	const env = claudeEnvironment(envInput);
	const command = await resolveClaudeExecutable(env);
	if (command === undefined) {
		return { available: false, loggedIn: false, subscription: false, detail: INSTALL_HINT };
	}

	let result: { code: number; stdout: string; stderr: string };
	try {
		result = await captureProcess(command, ["auth", "status"], env, signal);
	} catch (error) {
		if (signal?.aborted ?? false) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return {
			available: true,
			loggedIn: false,
			subscription: false,
			command,
			diagnostic: true,
			detail: `Claude Code status check failed: ${message}`,
		};
	}

	const payload = statusPayload(result.stdout);
	if (!payload) {
		// 起動や CLI の失敗をログアウトに見せかけない。
		const stdoutTail = outputTail(result.stdout);
		const stderrTail = outputTail(result.stderr);
		const output = stdoutTail !== "" ? stdoutTail : stderrTail !== "" ? stderrTail : "(no output)";
		return {
			available: true,
			loggedIn: false,
			subscription: false,
			command,
			diagnostic: true,
			detail: `Claude Code status check failed (exit ${result.code}): unexpected auth status output: ${output}`,
		};
	}

	// ログアウトは loggedIn: false の JSON で、終了コードが0でないこともある。ログイン状態は JSON だけを信じる。
	const loggedIn = payload.loggedIn ?? false;
	const plan = payload.subscriptionType ?? undefined;
	return {
		available: true,
		loggedIn,
		subscription: loggedIn && plan !== undefined && plan !== "",
		command,
		authMethod: payload.authMethod ?? undefined,
		plan,
		detail: loggedIn ? undefined : LOGIN_HINT,
	};
}

const READY_STATUS_TTL_MS = 60_000;
const readyStatusCache = new Map<string, { command: string; expires: number }>();

// ツール呼び出しのたびに新しいワーカーを起こすため、成功した確認は少しの間覚えて claude auth status の起動を省く。
async function readyClaudeCommand(envInput: Env, signal?: AbortSignal): Promise<string> {
	const env = claudeEnvironment(envInput);
	const key = JSON.stringify([env["PATH"], env["HOME"], env["CLAUDE_CONFIG_DIR"]]);
	const cached = readyStatusCache.get(key);
	if (cached && cached.expires > Date.now()) return cached.command;

	const status = await getClaudeStatus(env, signal);
	if (!status.available || status.command === undefined) throw new Error(INSTALL_HINT);
	if (!status.loggedIn) {
		readyStatusCache.delete(key);
		throw new Error(status.detail ?? LOGIN_HINT);
	}
	readyStatusCache.set(key, { command: status.command, expires: Date.now() + READY_STATUS_TTL_MS });
	return status.command;
}

async function childExit(child: ChildProcess): Promise<number> {
	return await new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code == null) reject(new Error(`Claude Code exited from signal ${signal ?? "unknown"}`));
			else resolveExit(code);
		});
	});
}

function killProcessTree(child: ChildProcess): void {
	if (child.exitCode != null || child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// 確認の間に終わった。
		}
	}
}

class AsyncQueue<T> {
	private readonly values: T[] = [];
	private readonly waiters: ((value: IteratorResult<T, undefined>) => void)[] = [];
	private ended = false;
	private failure: Error | undefined;

	push(value: T): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}

	end(error?: Error): void {
		this.ended = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	async next(signal: AbortSignal | undefined, timeoutMs: number): Promise<T | undefined> {
		if (this.values.length > 0) return this.values.shift();
		if (this.ended) {
			if (this.failure) throw this.failure;
			return undefined;
		}
		signal?.throwIfAborted();

		return await new Promise<T | undefined>((resolveNext, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				fn();
			};
			const waiter = (item: IteratorResult<T, undefined>) => {
				finish(() => {
					if ((item.done ?? false) && this.failure) reject(this.failure);
					else resolveNext((item.done ?? false) ? undefined : item.value);
				});
			};
			const onAbort = () => {
				finish(() => {
					reject(abortReason(signal));
				});
			};
			const timer = setTimeout(() => {
				finish(() => {
					reject(new Error("Claude Code stream timed out"));
				});
			}, timeoutMs);
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function abortReason(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;
	return reason instanceof Error ? reason : new Error("Claude Code request aborted");
}

function envFlagEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return (
		normalized !== undefined &&
		normalized !== "" &&
		!["0", "false", "no", "off"].includes(normalized)
	);
}

// 認証や課金の経路を黙って変えないよう、差し替えの指定があれば拒む。
function conflictingEnvironment(env: Record<string, string>): string[] {
	const conflicts = [
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_FOUNDRY_API_KEY",
	].filter((key) => env[key] !== undefined && env[key] !== "");
	for (const key of [
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
	]) {
		if (envFlagEnabled(env[key])) conflicts.push(key);
	}
	return conflicts;
}

function processEnvironment(
	input: Env | undefined,
	extraBody: Record<string, unknown>,
): Record<string, string> {
	const env = claudeEnvironment({ ...process.env, ...input });
	const conflicts = conflictingEnvironment(env);
	if (conflicts.length > 0) {
		throw new Error(
			`Claude Code subscription provider refuses conflicting auth/backend overrides: ${conflicts.join(", ")}`,
		);
	}
	delete env["CLAUDE_CODE_EXTRA_BODY"];
	Object.assign(env, {
		CLAUDE_CODE_ENTRYPOINT: "pi-agent",
		ENABLE_TOOL_SEARCH: "false",
		DISABLE_AUTOUPDATER: "1",
		DISABLE_FEEDBACK_COMMAND: "1",
		CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
		CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
		// どちらも user メッセージとツール結果へのリマインダーになる。リレーでも Claude Code が足したものは落とす。
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
		CLAUDE_CODE_MAX_RETRIES: "0",
		DISABLE_AUTO_COMPACT: "1",
		DISABLE_COMPACT: "1",
		CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
		DISABLE_ERROR_REPORTING: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
	});
	const maxTokens = extraBody["max_tokens"];
	if (typeof maxTokens === "number") env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = String(maxTokens);
	return env;
}

// 書いたフレームの uuid は、Claude Code がそのフレームの result で返してくる。
async function writeFrame(child: ChildProcess, frame: NativeFrame): Promise<string> {
	const stdin = child.stdin;
	if (stdin == null || !stdin.writable)
		throw new Error("Claude Code stdin closed during history replay");
	const uuid = randomUUID();
	if (!stdin.write(`${JSON.stringify({ ...frame, uuid })}\n`)) {
		await new Promise<void>((resolveDrain, reject) => {
			stdin.once("drain", resolveDrain);
			stdin.once("error", reject);
		});
	}
	return uuid;
}

function resultIsForAnotherMessage(result: NativeResult, uuid: string): boolean {
	const ids = result.user_message_uuids;
	return ids !== undefined && ids.length > 0 && !ids.includes(uuid);
}

function nativeErrorText(
	event: Extract<NativeOutputEvent, { type: "assistant" }>,
): string | undefined {
	const messageError = event.message["error"];
	if (!isPresent(event.error) && !isPresent(messageError)) return undefined;
	return event.message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isPresent(value: unknown): boolean {
	return value != null && value !== false && value !== "" && value !== 0;
}

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (!isRecord(value)) return value;
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key !== "cache_control") output[key] = withoutCacheControl(child);
	}
	return output;
}

const requestMessageSchema = z.looseObject({
	role: z.string().optional(),
	content: z.unknown().optional(),
});
type NativeRequestMessage = z.infer<typeof requestMessageSchema>;

const requestBodySchema = z.looseObject({
	messages: z.array(requestMessageSchema).optional(),
	system: z.unknown().optional(),
});

function requestMessages(body: Buffer | undefined): NativeRequestMessage[] | undefined {
	if (!body) return undefined;
	try {
		const payload = requestBodySchema.safeParse(JSON.parse(body.toString("utf8")));
		return payload.success ? payload.data.messages : undefined;
	} catch {
		return undefined;
	}
}

function deriveInitialSystemMessages(body: Buffer | undefined): unknown[] | undefined {
	const messages = requestMessages(body);
	if (messages?.[0]?.role !== "user") return undefined;
	let end = 1;
	while (messages[end]?.role === "system") end += 1;
	const systems = messages.slice(1, end);

	// 古い carrier から再生した履歴は日付のリマインダーが末尾にある。次の要求の先頭を揃えるため環境のリマインダーの隣に写す。
	let trailingStart = messages.length;
	while (trailingStart > end && messages[trailingStart - 1]?.role === "system") trailingStart -= 1;
	if (trailingStart < messages.length) systems.push(...messages.slice(trailingStart));
	return systems.length > 0 ? structuredClone(systems) : undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
		.join("");
}

function setCacheBreakpoint(message: NativeRequestMessage): void {
	if (typeof message.content === "string") {
		message.content = [
			{ type: "text", text: message.content, cache_control: { type: "ephemeral", ttl: "1h" } },
		];
		return;
	}
	if (!Array.isArray(message.content) || message.content.length === 0) return;
	const last: unknown = message.content.at(-1);
	if (!isRecord(last)) return;
	// 1メッセージに1つ。Claude Code が先のブロック（末尾の日付リマインダーなど）に付けていると、二つ目で上限の4つを超える。
	for (const block of message.content) {
		if (isRecord(block)) delete block["cache_control"];
	}
	last["cache_control"] = { type: "ephemeral", ttl: "1h" };
}

function setReplayCacheBreakpoints(messages: NativeRequestMessage[]): void {
	const userIndexes = messages
		.map((message, index) => (message.role === "user" ? index : -1))
		.filter((index) => index >= 0);
	const previousQuery = userIndexes.at(-2);
	if (userIndexes.length >= 3 && previousQuery !== undefined) {
		// 区切りは4つまでで、system プロンプトが2つ使う。自動の遡り（特に画像で当てにならない）に頼らず、環境の区切りを一つ前の問いの境界へ移す。
		for (const message of messages) {
			if (message.role === "system") message.content = withoutCacheControl(message.content);
		}
		const target = messages[previousQuery];
		if (target) setCacheBreakpoint(target);
	}
	const final = messages.at(-1);
	if (final) setCacheBreakpoint(final);
}

// Claude Code が縮小し座標の対応を書き足した画像の注記。
function isImageScaleNote(block: unknown): boolean {
	return (
		isRecord(block) &&
		block["type"] === "text" &&
		typeof block["text"] === "string" &&
		/^\[Image: original \d+x\d+/u.test(block["text"])
	);
}

// Claude Code が画像と文書の合計サイズの上限（tengu_media_byte_cap）で古いものを間引いた跡の注記。
// ツール結果の中では画像と同じ位置に置かれ、user メッセージ直下では中身が空になったときだけ置かれる。
function isMediaRemovedNote(block: unknown): block is Record<string, unknown> {
	return (
		isRecord(block) &&
		block["type"] === "text" &&
		typeof block["text"] === "string" &&
		block["text"].startsWith("[media removed: request limit.")
	);
}

function containsMediaRemovedNote(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsMediaRemovedNote);
	if (!isRecord(value)) return false;
	return isMediaRemovedNote(value) || containsMediaRemovedNote(value["content"]);
}

// 正規の画像に対応しうる Claude Code のブロック。間引かれた画像は注記の text ブロックになっている。
function isWireImageSlot(block: unknown): boolean {
	return (isRecord(block) && block["type"] === "image") || isMediaRemovedNote(block);
}

function findWireImage(wire: unknown[], cursor: number): number {
	return wire.findIndex((candidate, position) => position >= cursor && isWireImageSlot(candidate));
}

// 跡なく消えた画像の数。Claude Code は古い画像から順に外すので、消えるのは常に先頭側の画像になる。
function silentlyTrimmedImages(canonical: unknown[], wire: unknown[]): number {
	const images = canonical.filter((block) => isRecord(block) && block["type"] === "image").length;
	return Math.max(0, images - wire.filter(isWireImageSlot).length);
}

// Claude Code は user メッセージとツール結果にリマインダーを足すが、どれも luna の履歴ではない。
// 正規のブロックを種類で順に突き合わせ、足されたものは落とす。画像だけは縮小と座標の注記があり得るので Claude Code の写しを使う。
// mediaTrimmed は、Claude Code がこの要求で画像を間引いたかどうか。間引かれた画像は送らない（送り直すと上限を超える）。
function alignCanonicalContent(
	canonical: unknown[],
	wire: unknown[],
	where: string,
	mediaTrimmed: boolean,
): unknown[] {
	const output: unknown[] = [];
	let cursor = 0;
	// user メッセージ直下の画像は跡を残さず取り除かれる。注記がどこにも無ければ間引きではないので落とさない。
	let trimmed = mediaTrimmed ? silentlyTrimmedImages(canonical, wire) : 0;
	for (const block of canonical) {
		if (!isRecord(block)) {
			throw new Error(`Claude Code request has an invalid canonical block in ${where}`);
		}
		if (block["type"] === "image") {
			if (trimmed > 0) {
				trimmed -= 1;
				continue;
			}
			const index = findWireImage(wire, cursor);
			const native = wire[index];
			if (index < 0) {
				throw new Error(`Claude Code request lost a image block in ${where}`);
			}
			cursor = index + 1;
			output.push(withoutCacheControl(native));
			if (!isMediaRemovedNote(native) && isImageScaleNote(wire[cursor])) {
				output.push(withoutCacheControl(wire[cursor]));
				cursor += 1;
			}
			continue;
		}

		let index = -1;
		let native: Record<string, unknown> | undefined;
		for (let position = cursor; position < wire.length; position++) {
			const candidate = wire[position];
			if (
				isRecord(candidate) &&
				candidate["type"] === block["type"] &&
				(block["type"] !== "tool_result" || candidate["tool_use_id"] === block["tool_use_id"])
			) {
				index = position;
				native = candidate;
				break;
			}
		}
		if (native === undefined) {
			throw new Error(`Claude Code request lost a ${String(block["type"])} block in ${where}`);
		}
		cursor = index + 1;

		const blockContent = block["content"];
		const nativeContent = native["content"];
		if (
			block["type"] === "tool_result" &&
			Array.isArray(blockContent) &&
			Array.isArray(nativeContent)
		) {
			output.push({
				...structuredClone(block),
				content: alignCanonicalContent(blockContent, nativeContent, where, mediaTrimmed),
			});
		} else {
			output.push(structuredClone(block));
		}
	}
	return output;
}

function restoreCanonicalUserContent(
	messages: NativeRequestMessage[],
	frames: NativeFrame[],
	mediaTrimmed: boolean,
): void {
	const canonical = frames.filter((frame) => frame.type === "user");
	const native = messages.filter((message) => message.role === "user");
	if (native.length !== canonical.length) {
		throw new Error(
			`Claude Code request has ${native.length} user messages where Pi's history has ${canonical.length}`,
		);
	}
	for (const [index, message] of native.entries()) {
		const wire: unknown[] = Array.isArray(message.content)
			? message.content
			: typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: [];
		// 落としたブロックに区切りがあっても、このメッセージの区切りは残す。
		const markedBlock = wire.findLast(
			(block): block is Record<string, unknown> =>
				isRecord(block) && isPresent(block["cache_control"]),
		);
		const marker: unknown = markedBlock?.["cache_control"];
		const frame = canonical[index];
		if (frame === undefined) continue;
		const where = `user message ${index}`;
		const content = alignCanonicalContent(frame.message.content, wire, where, mediaTrimmed);
		// 画像だけのメッセージを Claude Code が空にするときは注記を置き、それが上で画像と対応する。空になるなら Claude Code の形と合っていない。
		if (content.length === 0) {
			throw new Error(`Claude Code request left no content in ${where}`);
		}
		const last = content.at(-1);
		if (marker !== undefined && isRecord(last)) {
			content[content.length - 1] = { ...last, cache_control: structuredClone(marker) };
		}
		message.content = content;
	}
}

function injectNativeSystemMessages(
	messages: NativeRequestMessage[],
	injections: NativeSystemInjection[],
): NativeRequestMessage[] {
	const byAssistant = new Map<number, NativeRequestMessage[]>();
	const trailing: NativeRequestMessage[] = [];
	for (const injection of injections) {
		const message = { role: "system", content: structuredClone(injection.content) };
		if (injection.beforeAssistant == null) trailing.push(message);
		else {
			const pending = byAssistant.get(injection.beforeAssistant) ?? [];
			pending.push(message);
			byAssistant.set(injection.beforeAssistant, pending);
		}
	}

	const output: NativeRequestMessage[] = [];
	let assistantOrdinal = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			output.push(...(byAssistant.get(assistantOrdinal) ?? []));
			byAssistant.delete(assistantOrdinal);
			assistantOrdinal += 1;
		}
		output.push(message);
	}
	if (byAssistant.size > 0) {
		throw new Error("Claude Code request lost an assistant boundary needed by system history");
	}
	output.push(...trailing);
	return output;
}

function normalizeLeadingSystemCache(system: unknown): void {
	if (!Array.isArray(system)) return;
	for (const block of system) {
		if (isRecord(block)) delete block["cache_control"];
	}
	const last: unknown = system.at(-1);
	if (isRecord(last)) last["cache_control"] = { type: "ephemeral", ttl: "1h" };
}

export function rewriteInitialRequest(
	body: Buffer,
	frames: NativeFrame[],
	initialSystemMessages: unknown[] | undefined,
	nativeSystemInjections?: NativeSystemInjection[],
): Buffer {
	const payload = requestBodySchema.parse(JSON.parse(body.toString("utf8")));
	let messages = payload.messages;
	const first = messages?.[0];
	if (messages === undefined || first?.role !== "user" || !Array.isArray(first.content)) {
		throw new Error("Claude Code request is missing its initial user message");
	}
	restoreCanonicalUserContent(messages, frames, containsMediaRemovedNote(messages));

	if (initialSystemMessages !== undefined && initialSystemMessages.length > 0) {
		let systemEnd = 1;
		while (messages[systemEnd]?.role === "system") systemEnd += 1;
		messages.splice(
			1,
			systemEnd - 1,
			...z.array(requestMessageSchema).parse(structuredClone(initialSystemMessages)),
		);

		const initialText = initialSystemMessages
			.map((message) => contentText(isRecord(message) ? message["content"] : undefined))
			.join("\n");
		while (messages.at(-1)?.role === "system") {
			const trailingText = contentText(messages.at(-1)?.content);
			if (trailingText === "" || !initialText.includes(trailingText)) break;
			messages.pop();
		}
	}

	if (nativeSystemInjections) {
		messages = injectNativeSystemMessages(messages, nativeSystemInjections);
		payload.messages = messages;
		normalizeLeadingSystemCache(payload.system);
	}
	if (
		(initialSystemMessages !== undefined && initialSystemMessages.length > 0) ||
		nativeSystemInjections
	) {
		setReplayCacheBreakpoints(messages);
	}

	return Buffer.from(JSON.stringify(payload));
}

const CLAUDE_PROCESS_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_CACHED_CLAUDE_PROCESSES = 4;

type ClaudeLaunchPlan = {
	env: Record<string, string>;
	fingerprint: string;
	timeoutMs: number;
};

function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value == null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.entries(value)
		.filter(([, child]) => child !== undefined)
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
		.join(",")}}`;
}

function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function frameHistoryHash(frames: NativeFrame[]): string {
	return digest(frames.map((frame) => ({ type: frame.type, message: frame.message })));
}

function assistantFrame(message: NativeMessage): NativeFrame {
	return { type: "assistant", message: { role: "assistant", content: message.content } };
}

function launchPlan(input: RunClaudeInput): ClaudeLaunchPlan {
	const timeoutMs = input.timeoutMs ?? 180_000;
	const env = processEnvironment(input.env, input.extraBody);
	return {
		env,
		timeoutMs,
		fingerprint: digest({
			cwd: resolve(input.cwd ?? process.cwd()),
			env,
			extraBody: input.extraBody,
			manifest: input.manifest,
			model: input.model,
			systemPrompt: input.systemPrompt,
			timeoutMs,
			upstreamUrl: input.upstreamUrl ?? "https://api.anthropic.com",
		}),
	};
}

type ExitOutcome = { code?: number; error?: Error };

class ClaudeProcess {
	busy = false;
	readonly createdAt = Date.now();
	lastUsed = this.createdAt;

	private tipHash: string | undefined;
	private expiryTimer: NodeJS.Timeout | undefined;
	private closed = false;
	private delivered = false;
	private stderr = "";

	private constructor(
		readonly fingerprint: string,
		private readonly root: string,
		private readonly child: ChildProcess,
		private readonly relay: TurnRelay,
		private readonly queue: AsyncQueue<NativeOutputEvent>,
		private readonly readTask: Promise<void>,
		private readonly exitOutcome: Promise<ExitOutcome>,
		private readonly timeoutMs: number,
	) {
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-65_536);
		});
	}

	static async create(input: RunClaudeInput, plan: ClaudeLaunchPlan): Promise<ClaudeProcess> {
		input.signal?.throwIfAborted();
		const command = await readyClaudeCommand({ ...process.env, ...input.env }, input.signal);

		const root = await mkdtemp(join(tmpdir(), "luna-claude-code-"));
		const toolsPath = join(root, "tools.json");
		const settingsPath = join(root, "settings.json");
		const systemPath = join(root, "system.md");
		const inertMcpPath = join(root, "inert-mcp.mjs");
		let child: ChildProcess | undefined;
		let relay: TurnRelay | undefined;

		try {
			await Promise.all([
				writeFile(toolsPath, JSON.stringify(input.manifest), "utf8"),
				writeFile(
					settingsPath,
					JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(input.extraBody) } }),
					"utf8",
				),
				writeFile(systemPath, input.systemPrompt, "utf8"),
				writeFile(inertMcpPath, INERT_MCP_SCRIPT, "utf8"),
			]);

			relay = new TurnRelay(input.upstreamUrl ?? "https://api.anthropic.com", plan.timeoutMs);
			const env = { ...plan.env, ANTHROPIC_BASE_URL: await relay.start() };
			const mcp = {
				mcpServers: { pi: { command: process.execPath, args: [inertMcpPath, toolsPath] } },
			};
			const args = [
				"-p",
				"--model",
				input.model,
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--tools",
				"",
				"--system-prompt-file",
				systemPath,
				"--settings",
				settingsPath,
				"--setting-sources",
				"",
				"--strict-mcp-config",
				"--disable-slash-commands",
				"--max-turns",
				"1",
				"--permission-mode",
				"dontAsk",
				"--no-session-persistence",
				"--mcp-config",
				JSON.stringify(mcp),
			];

			const spawned = spawn(command, args, {
				// Claude Code はモデルに自分の cwd を伝える。転送用のファイルは隠し、本当の作業ディレクトリを見せる。
				cwd: input.cwd ?? process.cwd(),
				env,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child = spawned;
			const queue = new AsyncQueue<NativeOutputEvent>();
			const reader = createInterface({ input: spawned.stdout, crlfDelay: Infinity });
			const readTask = (async () => {
				try {
					for await (const line of reader) {
						if (line.trim() === "") continue;
						let event: NativeOutputEvent | undefined;
						try {
							event = parseNativeOutputEvent(JSON.parse(line));
						} catch (error) {
							throw new Error(`Invalid Claude Code stream-json output: ${line.slice(0, 300)}`, {
								cause: error,
							});
						}
						if (event !== undefined) queue.push(event);
					}
					queue.end();
				} catch (error) {
					queue.end(error instanceof Error ? error : new Error(String(error)));
				}
			})();
			const exitOutcome = childExit(spawned).then(
				(code): ExitOutcome => ({ code }),
				(error: unknown): ExitOutcome => ({
					error: error instanceof Error ? error : new Error(String(error)),
				}),
			);
			return new ClaudeProcess(
				plan.fingerprint,
				root,
				spawned,
				relay,
				queue,
				readTask,
				exitOutcome,
				plan.timeoutMs,
			);
		} catch (error) {
			relay?.abort();
			if (child !== undefined && child.exitCode == null) killProcessTree(child);
			await relay?.close();
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	isAlive(): boolean {
		return !this.closed && this.child.exitCode == null && (this.child.stdin?.writable ?? false);
	}

	isExpired(now = Date.now()): boolean {
		return now - this.createdAt >= CLAUDE_PROCESS_MAX_AGE_MS;
	}

	canContinue(input: RunClaudeInput): boolean {
		if (this.tipHash === undefined || input.frames.length === 0) return false;
		return frameHistoryHash(input.frames.slice(0, -1)) === this.tipHash;
	}

	clearExpiryTimer(): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = undefined;
	}

	armExpiryTimer(expire: () => void): void {
		this.clearExpiryTimer();
		this.lastUsed = Date.now();
		const remainingLifetime = CLAUDE_PROCESS_MAX_AGE_MS - (this.lastUsed - this.createdAt);
		this.expiryTimer = setTimeout(expire, Math.max(0, remainingLifetime));
		this.expiryTimer.unref();
	}

	commit(input: RunClaudeInput, message: NativeMessage): boolean {
		// Claude Code は max-turns の result の前に MCP を内部で呼ぶ。拒否の応答が隠れた履歴に残り、luna は本当の結果を足すため、続きとして扱えない。
		if (message.content.some((block) => block.type === "tool_use")) {
			this.tipHash = undefined;
			return false;
		}
		this.tipHash = frameHistoryHash([...input.frames, assistantFrame(message)]);
		return true;
	}

	// ツール呼び出しで終わった応答までの履歴を流しておき、次の要求をツール結果の書き込みだけにする。
	async prepare(input: RunClaudeInput, message: NativeMessage): Promise<void> {
		// 再生の途中で Claude Code が生成を頼んでも、書き換えずに上流へ流さない。
		this.relay.finishTurn();
		const history: NativeFrame[] = [
			...input.frames.map((frame): NativeFrame =>
				frame.type === "user" ? { ...frame, shouldQuery: false } : frame,
			),
			assistantFrame(message),
		];
		await this.writeHistory(history, undefined);
		this.tipHash = frameHistoryHash(history);
	}

	get startedOutput(): boolean {
		return this.delivered || this.relay.used;
	}

	async run(input: RunClaudeInput, continuation: boolean): Promise<RunClaudeOutput> {
		if (!this.isAlive()) throw new Error("Claude Code process is no longer available");
		input.signal?.throwIfAborted();

		let sawMessageStop = false;
		this.delivered = false;
		const deliver = (event: AnthropicStreamEvent) => {
			this.delivered = true;
			if (event.type === "message_stop") sawMessageStop = true;
			input.onEvent?.(event);
		};
		this.relay.beginTurn(
			deliver,
			(body) =>
				rewriteInitialRequest(
					body,
					input.frames,
					input.initialSystemMessages,
					input.nativeSystemInjections,
				),
			input.betas,
		);

		const abort = () => {
			this.relay.abort();
			this.closeNow();
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		const assistants: NativeMessage[] = [];
		let result: NativeResult | undefined;
		let nativeError: string | undefined;
		let turnUuid: string | undefined;
		let rateLimit: RateLimitInfo | undefined;

		try {
			turnUuid = await this.writeHistory(
				continuation ? input.frames.slice(-1) : input.frames,
				input.signal,
			);

			while (true) {
				const event = await this.queue.next(input.signal, this.timeoutMs);
				if (!event) throw await this.exitError("Claude Code exited before completing its response");
				if (event.type === "assistant") {
					const error = nativeErrorText(event);
					if (error === undefined) assistants.push(event.message);
					else nativeError = error;
				} else if (event.type === "result") {
					// 前のターンの遅れた result がキューに残っていることがある。
					if (turnUuid !== undefined && resultIsForAnotherMessage(event, turnUuid)) continue;
					result = event;
					break;
				} else if (event.type === "rate_limit_event") {
					if (event.rate_limit_info) rateLimit = event.rate_limit_info;
				} else if (!this.relay.used) {
					deliver(event.event);
				}
			}
			await this.relay.settled();
			input.signal?.throwIfAborted();

			let message: NativeMessage | undefined;
			if (this.relay.used) {
				message = this.relayedMessage();
				sawMessageStop = true;
			} else {
				message = assistants.at(-1);
			}

			// エラーの assistant は集めていないので、"Incomplete" ではなくその本文を報告する。
			if (!message && nativeError !== undefined) {
				throw new Error(`Claude Code API error: ${nativeError}`);
			}
			if (!message || !sawMessageStop) {
				const detail = this.stderr.trim().slice(-500);
				throw new Error(
					`Incomplete Claude Code response: assistant, message_stop and one result required${detail === "" ? "" : ` (${detail})`}`,
				);
			}

			const nativeFailureHandled = this.relay.denied > 0 || message.stop_reason === "refusal";
			if (nativeError !== undefined && !nativeFailureHandled) {
				throw new Error(`Claude Code API error: ${nativeError}`);
			}
			const hasTools = message.content.some((block) => block.type === "tool_use");
			const maxTurnsBoundary = hasTools && result.subtype === "error_max_turns";
			if (
				!maxTurnsBoundary &&
				!nativeFailureHandled &&
				((result.is_error ?? false) || result.subtype !== "success")
			) {
				throw new Error(`Claude Code request failed: ${result.subtype ?? "unknown result"}`);
			}

			const usage = nativeUsageSchema.safeParse(message.usage ?? result.usage);
			if (!usage.success) {
				throw new Error("Claude Code response did not include complete token usage");
			}

			// 課金はもう済んでいるが、ここで止めれば luna のループが追加の要求を超過分に積まない。
			const chargeError = usageCreditsChargeError(rateLimit);
			if (chargeError) throw chargeError;

			return {
				message,
				result,
				usage: usage.data,
				exitCode: this.child.exitCode ?? 0,
				relay: {
					upstreamRequests: Number(this.relay.used),
					blockedRequests: this.relay.denied,
					...(this.relay.requestId === undefined ? {} : { requestId: this.relay.requestId }),
				},
				initialSystemMessages:
					input.initialSystemMessages ??
					deriveInitialSystemMessages(this.relay.originalRequestBody),
				...(rateLimit === undefined ? {} : { rateLimit }),
			};
		} finally {
			input.signal?.removeEventListener("abort", abort);
			this.relay.finishTurn();
		}
	}

	private async writeHistory(
		frames: NativeFrame[],
		signal: AbortSignal | undefined,
	): Promise<string | undefined> {
		let turnUuid: string | undefined;
		for (const frame of frames) {
			const uuid = await writeFrame(this.child, frame);
			if (frame.shouldQuery ?? true) {
				turnUuid = uuid;
				continue;
			}
			while (true) {
				const event = await this.queue.next(signal, this.timeoutMs);
				if (!event) {
					throw await this.exitError("Claude Code exited before acknowledging history replay");
				}
				if (event.type === "result") {
					if (event.num_turns !== 0 || (event.is_error ?? false)) {
						throw new Error("Claude Code rejected zero-turn history replay");
					}
					break;
				}
			}
		}
		return turnUuid;
	}

	// 再試行は luna の分類だけが頼りなので、一時的な失敗はそれと分かる言い回しにする。
	private relayedMessage(): NativeMessage {
		const relay = this.relay;
		if (relay.status === 200 && relay.capture.complete && relay.capture.message) {
			return relay.capture.message;
		}
		let detail = `status ${relay.status ?? "unknown"}, capture ${relay.capture.complete ? "complete" : "incomplete"}`;
		if (relay.failure !== undefined) detail += `, relay failure ${relay.failure}`;
		if (relay.denied > 0) detail += `, native retries denied ${relay.denied}`;
		const upstreamError = relay.errorText();
		if (upstreamError !== "") detail += `, upstream said: ${upstreamError.slice(0, 500)}`;
		if (relay.status === 200 && !relay.capture.complete && upstreamError === "") {
			throw new Error(`Claude Code upstream stream ended before message_stop (${detail})`);
		}
		if (relay.status === undefined && relay.upstreamFailed) {
			throw new Error(`Claude Code upstream connection lost before a response (${detail})`);
		}
		if (relay.status !== undefined && relay.status >= 500) {
			// 529 のような 5xx は本文によらず一時的。
			throw new Error(`Claude Code upstream server error (${detail})`);
		}
		throw new Error(`Incomplete Claude Code upstream response (${detail})`);
	}

	async close(): Promise<void> {
		this.closeNow();
		await Promise.allSettled([this.readTask, this.exitOutcome, this.relay.close()]);
		await rm(this.root, { recursive: true, force: true });
	}

	private closeNow(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearExpiryTimer();
		this.relay.abort();
		if (this.child.exitCode == null) killProcessTree(this.child);
	}

	private async exitError(fallback: string): Promise<Error> {
		const outcome = await this.exitOutcome;
		if (outcome.error) return outcome.error;
		const detail = this.stderr.trim().slice(-500);
		return new Error(
			`${fallback} (exit ${outcome.code ?? "unknown"}${detail === "" ? "" : `: ${detail}`})`,
		);
	}
}

type AcquiredProcess = {
	worker: ClaudeProcess;
	retained: boolean;
	continuation: boolean;
	sessionId: string | undefined;
};

const processCache = new Map<string, ClaudeProcess>();
let managerTail: Promise<void> = Promise.resolve();

async function withManagerLock<T>(operation: () => Promise<T> | T): Promise<T> {
	const previous = managerTail;
	const { promise, resolve: release } = Promise.withResolvers<undefined>();
	managerTail = promise;
	await previous;
	try {
		return await operation();
	} finally {
		release(undefined);
	}
}

async function expireProcess(sessionId: string, worker: ClaudeProcess): Promise<void> {
	const expired = await withManagerLock(() => {
		if (processCache.get(sessionId) !== worker || worker.busy || !worker.isExpired()) return false;
		processCache.delete(sessionId);
		return true;
	});
	if (expired) await worker.close();
}

async function discardProcess({
	sessionId,
	worker,
}: Pick<AcquiredProcess, "sessionId" | "worker">): Promise<void> {
	if (sessionId !== undefined && processCache.get(sessionId) === worker) {
		await withManagerLock(() => {
			if (processCache.get(sessionId) === worker) processCache.delete(sessionId);
		});
	}
	await worker.close();
}

async function acquireProcess(
	input: RunClaudeInput,
	plan: ClaudeLaunchPlan,
): Promise<AcquiredProcess> {
	return await withManagerLock(async () => {
		const sessionId = input.sessionId;
		const cached = sessionId === undefined ? undefined : processCache.get(sessionId);
		if (sessionId !== undefined && cached && !cached.busy) {
			cached.clearExpiryTimer();
			if (
				cached.isAlive() &&
				!cached.isExpired() &&
				cached.fingerprint === plan.fingerprint &&
				cached.canContinue(input)
			) {
				cached.busy = true;
				return { worker: cached, retained: true, continuation: true, sessionId };
			}
			processCache.delete(sessionId);
			await cached.close();
		}

		// 同時に来た要求にキャッシュの会話を触らせない。セッション ID の無い要求と同じく使い捨てのプロセスにする。
		const retained = sessionId !== undefined && !(cached?.busy ?? false) && (await makeCacheRoom());
		const worker = await ClaudeProcess.create(input, plan);
		worker.busy = true;
		if (retained) processCache.set(sessionId, worker);
		return { worker, retained, continuation: false, sessionId };
	});
}

// 管理のロックの中で呼ぶ。すべて使用中なら空けられない。
async function makeCacheRoom(): Promise<boolean> {
	while (processCache.size >= MAX_CACHED_CLAUDE_PROCESSES) {
		const victim = [...processCache.entries()]
			.filter(([, worker]) => !worker.busy)
			.toSorted((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
		if (!victim) return false;
		processCache.delete(victim[0]);
		await victim[1].close();
	}
	return true;
}

// 要求の途中でセッションが閉じられたかの印。閉じた後に先読みのプロセスを作って取り残さないために使う。
type SessionLease = { closed: boolean };

const sessionLeases = new Map<string, Set<SessionLease>>();

function openLease(sessionId: string): SessionLease {
	const lease: SessionLease = { closed: false };
	const leases = sessionLeases.get(sessionId) ?? new Set();
	leases.add(lease);
	sessionLeases.set(sessionId, leases);
	return lease;
}

function releaseLease(sessionId: string, lease: SessionLease): void {
	const leases = sessionLeases.get(sessionId);
	leases?.delete(lease);
	if (leases?.size === 0) sessionLeases.delete(sessionId);
}

const preparations = new Map<string, Promise<void>>();

// luna がツールを実行している間に、次の要求を受けるプロセスを起動して履歴を流しておく。
// 失敗は報告しない。次の要求が自分で起動し直し、同じ失敗をその要求の失敗として返す。
function prepareNextProcess(
	input: RunClaudeInput,
	plan: ClaudeLaunchPlan,
	message: NativeMessage,
	sessionId: string,
	lease: SessionLease,
): void {
	const { signal: _signal, onEvent: _onEvent, ...prepareInput } = input;
	const task = (async () => {
		const worker = await withManagerLock(async () => {
			if (lease.closed || processCache.has(sessionId) || !(await makeCacheRoom())) {
				return undefined;
			}
			const created = await ClaudeProcess.create(prepareInput, plan);
			created.busy = true;
			processCache.set(sessionId, created);
			return created;
		});
		if (worker === undefined) return;
		try {
			await worker.prepare(prepareInput, message);
		} catch {
			await discardProcess({ sessionId, worker });
			return;
		}
		worker.busy = false;
		worker.armExpiryTimer(() => {
			void expireProcess(sessionId, worker);
		});
	})()
		.catch(() => undefined)
		.finally(() => {
			releaseLease(sessionId, lease);
			if (preparations.get(sessionId) === task) preparations.delete(sessionId);
		});
	preparations.set(sessionId, task);
}

async function waitForPreparation(sessionId: string, signal?: AbortSignal): Promise<void> {
	const preparation = preparations.get(sessionId);
	if (preparation === undefined) return;
	if (signal === undefined) {
		await preparation;
		return;
	}
	signal.throwIfAborted();
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => {
		reject(abortReason(signal));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([preparation, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

// 1つのセッション、または全セッションの温まったプロセスを閉じる。
// 用意の途中のプロセスもキャッシュにあるので閉じる。まだ作っていない用意は印を見て作らない。
export async function closeClaudeProcesses(sessionId?: string): Promise<void> {
	for (const [id, leases] of sessionLeases) {
		if (sessionId !== undefined && id !== sessionId) continue;
		for (const lease of leases) lease.closed = true;
		sessionLeases.delete(id);
	}
	const workers = await withManagerLock(() => {
		if (sessionId !== undefined) {
			const worker = processCache.get(sessionId);
			processCache.delete(sessionId);
			return worker ? [worker] : [];
		}
		const all = [...processCache.values()];
		processCache.clear();
		return all;
	});
	await Promise.allSettled(
		workers.map(async (worker) => {
			await worker.close();
		}),
	);
}

export function cachedClaudeProcessCount(): number {
	return processCache.size;
}

registerSessionResourceCleanup((sessionId) => {
	void closeClaudeProcesses(sessionId);
});

type SpareState = {
	spare: Promise<ClaudeProcess | undefined> | undefined;
	refreshTimer: NodeJS.Timeout | undefined;
};

const spareSessions = new Map<string, SpareState>();

// 毎回の要求が履歴の続きにならず温まったプロセスを使い回せないセッションのため、次の要求を受ける起動済みのプロセスを1つ控える。
// 控えたプロセスは使い回しの枠（processCache）に入れず、使ったら捨てる。会話の温まったプロセスを追い出さないため。
export function keepSpareClaudeProcess(sessionId: string): () => Promise<void> {
	const state: SpareState = { spare: undefined, refreshTimer: undefined };
	spareSessions.set(sessionId, state);
	return async () => {
		if (spareSessions.get(sessionId) === state) spareSessions.delete(sessionId);
		clearTimeout(state.refreshTimer);
		const spare = state.spare;
		state.spare = undefined;
		await (await spare)?.close();
	};
}

function launchSpare(
	sessionId: string,
	state: SpareState,
	input: RunClaudeInput,
	plan: ClaudeLaunchPlan,
): void {
	if (spareSessions.get(sessionId) !== state) return;
	clearTimeout(state.refreshTimer);
	const { signal: _signal, onEvent: _onEvent, ...spareInput } = input;
	// 起動の失敗はここでは報告しない。次の要求が自分で起動し直し、同じ失敗をその要求の失敗として返す。
	const spare = ClaudeProcess.create(spareInput, plan).catch(() => undefined);
	state.spare = spare;
	void spare.then((worker) => {
		// 控えから外れたものは、外した側（要求・解放・入れ替え）が閉じる。
		if (worker === undefined || state.spare !== spare || spareSessions.get(sessionId) !== state) {
			return;
		}
		state.refreshTimer = setTimeout(() => {
			if (state.spare !== spare) return;
			launchSpare(sessionId, state, spareInput, plan);
			void worker.close();
		}, CLAUDE_PROCESS_MAX_AGE_MS);
		state.refreshTimer.unref();
	});
}

async function takeSpare(
	state: SpareState,
	plan: ClaudeLaunchPlan,
): Promise<ClaudeProcess | undefined> {
	const pending = state.spare;
	state.spare = undefined;
	clearTimeout(state.refreshTimer);
	const spare = await pending;
	if (spare === undefined) return undefined;
	if (spare.fingerprint === plan.fingerprint && spare.isAlive() && !spare.isExpired()) return spare;
	await spare.close();
	return undefined;
}

async function runWithSpare(
	input: RunClaudeInput,
	plan: ClaudeLaunchPlan,
	sessionId: string,
	state: SpareState,
): Promise<RunClaudeOutput> {
	const worker = (await takeSpare(state, plan)) ?? (await ClaudeProcess.create(input, plan));
	launchSpare(sessionId, state, input, plan);
	try {
		return await worker.run(input, false);
	} finally {
		await worker.close();
	}
}

export async function runClaudeRequest(input: RunClaudeInput): Promise<RunClaudeOutput> {
	input.signal?.throwIfAborted();
	const plan = launchPlan(input);
	const spareState = input.sessionId === undefined ? undefined : spareSessions.get(input.sessionId);
	if (input.sessionId !== undefined && spareState !== undefined) {
		return await runWithSpare(input, plan, input.sessionId, spareState);
	}
	const lease = input.sessionId === undefined ? undefined : openLease(input.sessionId);
	let leaseHandedOff = false;
	try {
		if (input.sessionId !== undefined) await waitForPreparation(input.sessionId, input.signal);
		const acquired = await acquireProcess(input, plan);
		try {
			const output = await acquired.worker.run(input, acquired.continuation);
			const stable = acquired.worker.commit(input, output.message);
			const { sessionId } = acquired;
			if (
				stable &&
				acquired.retained &&
				sessionId !== undefined &&
				processCache.get(sessionId) === acquired.worker
			) {
				acquired.worker.busy = false;
				acquired.worker.armExpiryTimer(() => {
					void expireProcess(sessionId, acquired.worker);
				});
			} else {
				await discardProcess(acquired);
				if (!stable && acquired.retained && sessionId !== undefined && lease !== undefined) {
					prepareNextProcess(input, plan, output.message, sessionId, lease);
					leaseHandedOff = true;
				}
			}
			return output;
		} catch (error) {
			await discardProcess(acquired);
			// 温まったプロセスは古い隠れた状態を持ち得る。出力も API への到達も無ければ見せても課金してもいないので、新しいプロセスで一度だけやり直す。
			if (
				acquired.continuation &&
				!acquired.worker.startedOutput &&
				!(input.signal?.aborted ?? false)
			) {
				return await runClaudeRequest(input);
			}
			throw error;
		}
	} finally {
		if (lease !== undefined && input.sessionId !== undefined && !leaseHandedOff) {
			releaseLease(input.sessionId, lease);
		}
	}
}
