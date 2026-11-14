import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { constants as osConstants } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { hasErrorCode } from "../../../../../shared/error-code";
import type { JsonObject } from "../../../../../shared/json";
import type { AgentTool, AgentToolResult } from "../../../ports/outbound/agent-session-port";

// 定数とツール定義・出力書式は Codex の unified exec (codex-rs/core/src/unified_exec) に合わせている。
const SHELL_PATH = "/bin/bash";
const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const MIN_EMPTY_YIELD_TIME_MS = 5_000;
const MAX_EMPTY_YIELD_TIME_MS = 300_000;
// Codex はモデルごとの切り詰めポリシーで上限を掛ける。GPT 系の既定ポリシーと同じ値で固定する。
const MAX_OUTPUT_TOKENS = 10_000;
const OUTPUT_MAX_BYTES = 1024 * 1024;
const APPROX_BYTES_PER_TOKEN = 4;
const DEFAULT_MAX_SESSIONS = 64;
const PROTECTED_RECENT_SESSIONS = 8;
const POST_EXIT_CLOSE_WAIT_MS = 50;
const TERMINATE_GRACE_MS = 2_000;
const GROUP_EXIT_POLL_MS = 20;
const INTERRUPT = "\u0003";
const UNIFIED_EXEC_ENV: Readonly<Record<string, string>> = {
	NO_COLOR: "1",
	TERM: "dumb",
	LANG: "C.UTF-8",
	LC_CTYPE: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	COLORTERM: "",
	PAGER: "cat",
	GIT_PAGER: "cat",
	GH_PAGER: "cat",
};

export type ShellToolsOptions = Readonly<{
	cwd: string;
	// 子プロセスへ渡す環境変数。秘密情報を除くのは呼び出し側の責務。
	env: Readonly<Record<string, string | undefined>>;
	maxSessions?: number;
}>;

export type ShellTools = Readonly<{
	tools: readonly AgentTool[];
	dispose(): Promise<void>;
}>;

const execCommandArgumentsSchema = z.object({
	cmd: z.string(),
	workdir: z.string().optional(),
	tty: z.boolean().optional(),
	login: z.boolean().optional(),
	yield_time_ms: z.number().int().nonnegative().optional(),
	max_output_tokens: z.number().int().nonnegative().optional(),
});

const writeStdinArgumentsSchema = z.object({
	session_id: z.number().int(),
	chars: z.string().optional(),
	yield_time_ms: z.number().int().nonnegative().optional(),
	max_output_tokens: z.number().int().nonnegative().optional(),
});

const MAX_OUTPUT_TOKENS_PARAMETER = {
	type: "number",
	description:
		"Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
} as const;

const EXEC_COMMAND_PARAMETERS: JsonObject = {
	type: "object",
	properties: {
		cmd: { type: "string", description: "Shell command to execute." },
		workdir: {
			type: "string",
			description: "Working directory for the command. Defaults to the turn cwd.",
		},
		tty: {
			type: "boolean",
			description:
				"True keeps stdin open as a plain pipe so write_stdin can send input; no PTY is allocated, so programs see a non-terminal stdin. False or omitted closes stdin.",
		},
		yield_time_ms: {
			type: "number",
			description:
				"Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
		},
		max_output_tokens: MAX_OUTPUT_TOKENS_PARAMETER,
		login: {
			type: "boolean",
			description:
				"True runs the shell with -l/-i semantics; false disables them. Defaults to true.",
		},
	},
	required: ["cmd"],
	additionalProperties: false,
};

const WRITE_STDIN_PARAMETERS: JsonObject = {
	type: "object",
	properties: {
		session_id: {
			type: "number",
			description: "Identifier of the running unified exec session.",
		},
		chars: {
			type: "string",
			description: "Bytes to write to stdin. Defaults to empty, which polls without writing.",
		},
		yield_time_ms: {
			type: "number",
			description:
				"Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
		},
		max_output_tokens: MAX_OUTPUT_TOKENS_PARAMETER,
	},
	required: ["session_id"],
	additionalProperties: false,
};

type ShellSession = {
	readonly id: number;
	readonly pid: number;
	readonly child: ChildProcess;
	readonly stdinOpen: boolean;
	readonly exited: Promise<void>;
	readonly outputClosed: Promise<void>;
	exitCode: number | null;
	pending: HeadTailBuffer;
	lastUsed: number;
	busy: boolean;
	queue: Promise<void>;
	termination: Promise<void> | null;
};

type CollectedOutput = Readonly<{
	output: HeadTailBuffer;
	wallTimeMs: number;
}>;

export function createShellTools(options: ShellToolsOptions): ShellTools {
	const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
	const childEnv = { ...options.env, ...UNIFIED_EXEC_ENV };
	const sessions = new Map<number, ShellSession>();
	const terminations = new Set<Promise<void>>();
	let useCounter = 0;
	let disposed = false;

	const trackTermination = (session: ShellSession): void => {
		const termination = terminateProcessGroup(session);
		terminations.add(termination);
		void termination.finally(() => terminations.delete(termination));
	};

	const allocateSessionId = (): number => {
		for (;;) {
			const id = randomInt(1_000, 100_000);
			if (!sessions.has(id)) {
				return id;
			}
		}
	};

	// Codex と同じく最近使った8件を守り、終了済みを優先して最も古いセッションを追い出す。
	const pruneSessionsIfNeeded = (): void => {
		if (sessions.size < maxSessions) {
			return;
		}
		const entries = [...sessions.values()];
		const protectedIds = new Set(
			entries
				.toSorted((left, right) => right.lastUsed - left.lastUsed)
				.slice(0, Math.min(PROTECTED_RECENT_SESSIONS, maxSessions - 1))
				.map((session) => session.id),
		);
		const candidates = entries
			.filter((session) => !protectedIds.has(session.id) && !session.busy)
			.toSorted((left, right) => left.lastUsed - right.lastUsed);
		const victim = candidates.find((session) => session.exitCode != null) ?? candidates[0];
		if (victim == null) {
			return;
		}
		sessions.delete(victim.id);
		trackTermination(victim);
	};

	// 終了したセッションは Codex と同様にグループに残った子孫ごと片付ける。
	const finishSession = (session: ShellSession): void => {
		if (sessions.get(session.id) === session) {
			sessions.delete(session.id);
		}
		trackTermination(session);
	};

	const execCommand = async (
		argumentsValue: unknown,
		signal: AbortSignal,
	): Promise<AgentToolResult> => {
		const parsed = execCommandArgumentsSchema.safeParse(argumentsValue);
		if (!parsed.success) {
			return parseFailure(parsed.error);
		}
		if (disposed) {
			return errorResult("exec_command failed: shell tools are disposed");
		}
		const args = parsed.data;
		const workdir =
			args.workdir == null || args.workdir === ""
				? options.cwd
				: path.resolve(options.cwd, args.workdir);
		const stdinOpen = args.tty ?? false;
		const child = spawn(SHELL_PATH, [(args.login ?? true) ? "-lc" : "-c", args.cmd], {
			cwd: workdir,
			env: childEnv,
			stdio: [stdinOpen ? "pipe" : "ignore", "pipe", "pipe"],
			// setsid() で独立したプロセスグループにし、終了時にグループごとシグナルを送れるようにする。
			detached: true,
		});
		const { pid } = child;
		if (pid == null) {
			const reason = await once(child, "spawn").then(
				() => "process id is unavailable",
				(error: unknown) => describeError(error),
			);
			return errorResult(
				`exec_command failed: Failed to create unified exec process: ${reason} (workdir: ${workdir})`,
			);
		}

		pruneSessionsIfNeeded();
		const session = startSession(allocateSessionId(), pid, child, stdinOpen, useCounter++);
		sessions.set(session.id, session);

		const { output, wallTimeMs } = await runExclusive(session, () =>
			collectOutput(
				session,
				clamp(
					args.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
					MIN_YIELD_TIME_MS,
					MAX_YIELD_TIME_MS,
				),
				signal,
			),
		);
		const exitCode = session.exitCode;
		if (exitCode != null) {
			finishSession(session);
		}
		return {
			text: formatResponse({
				wallTimeMs,
				exitCode,
				sessionId: exitCode == null ? session.id : null,
				output,
				maxOutputTokens: resolveMaxOutputTokens(args.max_output_tokens),
			}),
			images: [],
			isError: false,
		};
	};

	const writeStdin = async (
		argumentsValue: unknown,
		signal: AbortSignal,
	): Promise<AgentToolResult> => {
		const parsed = writeStdinArgumentsSchema.safeParse(argumentsValue);
		if (!parsed.success) {
			return parseFailure(parsed.error);
		}
		const args = parsed.data;
		const unknownSession = errorResult(
			`write_stdin failed: Unknown process id ${String(args.session_id)}`,
		);
		const session = sessions.get(args.session_id);
		if (session == null) {
			return unknownSession;
		}

		const result = await runExclusive(session, async () => {
			if (sessions.get(session.id) !== session) {
				return null;
			}
			session.lastUsed = useCounter++;
			const chars = args.chars ?? "";
			if (chars !== "" && session.exitCode == null) {
				const writeError = sendInput(session, chars);
				if (writeError != null) {
					return writeError;
				}
			}
			const requested = Math.max(
				args.yield_time_ms ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
				MIN_YIELD_TIME_MS,
			);
			const yieldTimeMs =
				chars === ""
					? clamp(requested, MIN_EMPTY_YIELD_TIME_MS, MAX_EMPTY_YIELD_TIME_MS)
					: Math.min(requested, MAX_YIELD_TIME_MS);
			return await collectOutput(session, yieldTimeMs, signal);
		});
		if (result == null) {
			return unknownSession;
		}
		if ("isError" in result) {
			return result;
		}

		const exitCode = session.exitCode;
		if (exitCode != null) {
			finishSession(session);
		} else if (sessions.get(session.id) !== session) {
			return unknownSession;
		}
		return {
			text: formatResponse({
				wallTimeMs: result.wallTimeMs,
				exitCode,
				sessionId: exitCode == null ? session.id : null,
				output: result.output,
				maxOutputTokens: resolveMaxOutputTokens(args.max_output_tokens),
			}),
			images: [],
			isError: false,
		};
	};

	return {
		tools: [
			{
				name: "exec_command",
				description:
					"Runs a command with plain pipes (no PTY), returning output or a session ID for ongoing interaction.",
				parameters: EXEC_COMMAND_PARAMETERS,
				execute: execCommand,
			},
			{
				name: "write_stdin",
				description:
					"Writes characters to an existing unified exec session and returns recent output.",
				parameters: WRITE_STDIN_PARAMETERS,
				execute: writeStdin,
			},
		],
		dispose: async () => {
			disposed = true;
			const remaining = [...sessions.values()];
			sessions.clear();
			for (const session of remaining) {
				trackTermination(session);
			}
			await Promise.all(terminations);
		},
	};
}

function startSession(
	id: number,
	pid: number,
	child: ChildProcess,
	stdinOpen: boolean,
	lastUsed: number,
): ShellSession {
	const exited = Promise.withResolvers<void>();
	const outputClosed = Promise.withResolvers<void>();
	const session: ShellSession = {
		id,
		pid,
		child,
		stdinOpen,
		exited: exited.promise,
		outputClosed: outputClosed.promise,
		exitCode: null,
		pending: new HeadTailBuffer(OUTPUT_MAX_BYTES),
		lastUsed,
		busy: false,
		queue: Promise.resolve(),
		termination: null,
	};
	const onData = (chunk: Buffer): void => {
		session.pending.push(chunk);
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	// 子が先に stdin を閉じると EPIPE が非同期に届くため、握りつぶしてプロセスを落とさない。
	child.stdin?.on("error", () => undefined);
	child.on("error", () => undefined);
	child.once("exit", (code, signal) => {
		session.exitCode = code ?? (signal == null ? -1 : 128 + osConstants.signals[signal]);
		exited.resolve();
	});
	child.once("close", () => {
		outputClosed.resolve();
	});
	return session;
}

async function runExclusive<T>(session: ShellSession, task: () => Promise<T>): Promise<T> {
	const previous = session.queue;
	const current = Promise.withResolvers<void>();
	session.queue = current.promise;
	await previous;
	session.busy = true;
	try {
		return await task();
	} finally {
		session.busy = false;
		current.resolve();
	}
}

// Codex と同じく、プロセスが終了するか待ち時間が尽きるまで出力を溜めてから返す。
async function collectOutput(
	session: ShellSession,
	yieldTimeMs: number,
	signal: AbortSignal,
): Promise<CollectedOutput> {
	const startedAt = performance.now();
	const deadline = startedAt + yieldTimeMs;
	if (await waitUntil(session.exited, yieldTimeMs, signal)) {
		const remaining = deadline - performance.now();
		await waitUntil(session.outputClosed, Math.min(POST_EXIT_CLOSE_WAIT_MS, remaining), signal);
	}
	const output = session.pending;
	session.pending = new HeadTailBuffer(OUTPUT_MAX_BYTES);
	return { output, wallTimeMs: performance.now() - startedAt };
}

function sendInput(session: ShellSession, chars: string): AgentToolResult | null {
	// PTY がないので Ctrl-C は端末の行規律の代わりにグループへ SIGINT を送る (Codex の非TTY時と同じ)。
	if (chars === INTERRUPT) {
		signalProcessGroup(session.pid, "SIGINT");
		return null;
	}
	const { stdin } = session.child;
	if (!session.stdinOpen || stdin == null) {
		return errorResult(
			"write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
		);
	}
	if (stdin.destroyed) {
		return errorResult("write_stdin failed: failed to write to stdin");
	}
	// 子が読まずにパイプが詰まると書き込み完了が返らないため、完了は待たずに出力の待機へ進む。
	stdin.write(chars);
	return null;
}

function waitUntil(
	target: Promise<void>,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (reached: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(reached);
		};
		const onAbort = (): void => {
			finish(false);
		};
		const timer = setTimeout(finish, Math.max(0, timeoutMs), false);
		signal.addEventListener("abort", onAbort, { once: true });
		void target.then(() => {
			finish(true);
		});
		if (signal.aborted) {
			finish(false);
		}
	});
}

function terminateProcessGroup(session: ShellSession): Promise<void> {
	session.termination ??= (async () => {
		if (!signalProcessGroup(session.pid, "SIGTERM")) {
			return;
		}
		const deadline = performance.now() + TERMINATE_GRACE_MS;
		while (performance.now() < deadline) {
			if (!isProcessGroupAlive(session.pid)) {
				return;
			}
			await delay(GROUP_EXIT_POLL_MS);
		}
		signalProcessGroup(session.pid, "SIGKILL");
	})();
	return session.termination;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return hasErrorCode(error, "EPERM");
	}
}

function formatResponse(
	response: Readonly<{
		wallTimeMs: number;
		exitCode: number | null;
		sessionId: number | null;
		output: HeadTailBuffer;
		maxOutputTokens: number;
	}>,
): string {
	const originalTokenCount = approxTokensFromByteCount(response.output.totalBytes);
	const header = [
		`Chunk ID: ${generateChunkId()}`,
		`Wall time: ${(response.wallTimeMs / 1000).toFixed(4)} seconds`,
	];
	if (response.exitCode != null) {
		header.push(`Process exited with code ${String(response.exitCode)}`);
	}
	if (response.sessionId != null) {
		header.push(`Process running with session ID ${String(response.sessionId)}`);
	}
	header.push(`Original token count: ${String(originalTokenCount)}`, "Output:");
	const output = renderOutput(
		response.output.toText(),
		response.output.omittedBytes,
		response.maxOutputTokens,
		originalTokenCount,
	);
	return `${header.join("\n")}\n${output}`;
}

// Codex の CapturedStream::render と同じ規則で、収集上限で落ちた分の注記とトークン予算での中略を付ける。
function renderOutput(
	text: string,
	omittedBytes: number,
	maxTokens: number,
	originalTokenCount: number,
): string {
	const textBytes = Buffer.byteLength(text);
	const budget = maxTokens * APPROX_BYTES_PER_TOKEN;
	if (omittedBytes === 0) {
		if (textBytes <= budget) {
			return text;
		}
		return `Warning: truncated output (original token count: ${String(approxTokensFromByteCount(textBytes))})\nTotal output lines: ${String(countLines(text))}\n\n${truncateMiddle(text, maxTokens)}`;
	}
	const truncated = truncateMiddle(text, maxTokens);
	const marker = formatOmissionMarker(omittedBytes);
	const notice = truncated.includes(marker) ? "" : `${marker}\n`;
	if (textBytes <= budget) {
		return `${notice}${truncated}`;
	}
	return `Warning: truncated output (original token count: ${String(originalTokenCount)})\n${notice}\n${truncated}`;
}

function truncateMiddle(text: string, maxTokens: number): string {
	const bytes = Buffer.from(text, "utf8");
	const maxBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
	if (bytes.length <= maxBytes) {
		return text;
	}
	const leftBudget = Math.floor(maxBytes / 2);
	const rightBudget = maxBytes - leftBudget;
	const prefixEnd = floorCharBoundary(bytes, leftBudget);
	const suffixStart = ceilCharBoundary(bytes, bytes.length - rightBudget);
	const removedTokens = approxTokensFromByteCount(bytes.length - maxBytes);
	return `${bytes.subarray(0, prefixEnd).toString("utf8")}…${String(removedTokens)} tokens truncated…${bytes.subarray(suffixStart).toString("utf8")}`;
}

function floorCharBoundary(bytes: Buffer, index: number): number {
	let boundary = Math.min(index, bytes.length);
	while (boundary > 0 && isContinuationByte(bytes[boundary])) {
		boundary -= 1;
	}
	return boundary;
}

function ceilCharBoundary(bytes: Buffer, index: number): number {
	let boundary = Math.max(index, 0);
	while (boundary < bytes.length && isContinuationByte(bytes[boundary])) {
		boundary += 1;
	}
	return boundary;
}

function isContinuationByte(byte: number | undefined): boolean {
	return byte != null && (byte & 0xc0) === 0x80;
}

// Rust の str::lines() と同じく末尾の改行は行を増やさない。
function countLines(text: string): number {
	if (text === "") {
		return 0;
	}
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function approxTokensFromByteCount(bytes: number): number {
	return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN);
}

function formatOmissionMarker(omittedBytes: number): string {
	return `... ${String(omittedBytes)} bytes omitted ...`;
}

function generateChunkId(): string {
	return Array.from({ length: 6 }, () => randomInt(16).toString(16)).join("");
}

function resolveMaxOutputTokens(requested: number | undefined): number {
	return Math.min(requested ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function parseFailure(error: z.ZodError): AgentToolResult {
	return errorResult(`failed to parse function arguments: ${z.prettifyError(error)}`);
}

function errorResult(text: string): AgentToolResult {
	return { text, images: [], isError: true };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// 先頭と末尾を半分ずつ保持し、中間を捨てて捨てたバイト数を数える (Codex の HeadTailBuffer)。
class HeadTailBuffer {
	private readonly head: Buffer[] = [];
	private headBytes = 0;
	private tail: Buffer[] = [];
	private tailBytes = 0;
	private omitted = 0;
	private readonly headBudget: number;
	private readonly tailBudget: number;

	public constructor(maxBytes: number) {
		this.headBudget = Math.floor(maxBytes / 2);
		this.tailBudget = maxBytes - this.headBudget;
	}

	public get omittedBytes(): number {
		return this.omitted;
	}

	public get totalBytes(): number {
		return this.headBytes + this.tailBytes + this.omitted;
	}

	public push(chunk: Buffer): void {
		const headRoom = this.headBudget - this.headBytes;
		let rest = chunk;
		if (headRoom > 0) {
			const head = rest.subarray(0, headRoom);
			this.head.push(head);
			this.headBytes += head.length;
			rest = rest.subarray(head.length);
		}
		if (rest.length === 0) {
			return;
		}
		if (rest.length >= this.tailBudget) {
			this.omitted += this.tailBytes + rest.length - this.tailBudget;
			this.tail = [rest.subarray(rest.length - this.tailBudget)];
			this.tailBytes = this.tailBudget;
			return;
		}
		this.tail.push(rest);
		this.tailBytes += rest.length;
		let excess = this.tailBytes - this.tailBudget;
		while (excess > 0) {
			const first = this.tail[0];
			if (first == null) {
				break;
			}
			const dropped = Math.min(first.length, excess);
			if (dropped === first.length) {
				this.tail.shift();
			} else {
				this.tail[0] = first.subarray(dropped);
			}
			this.tailBytes -= dropped;
			this.omitted += dropped;
			excess -= dropped;
		}
	}

	public toText(): string {
		const parts = [...this.head];
		if (this.omitted > 0) {
			parts.push(Buffer.from(`\n${formatOmissionMarker(this.omitted)}\n`));
		}
		parts.push(...this.tail);
		return Buffer.concat(parts).toString("utf8");
	}
}
