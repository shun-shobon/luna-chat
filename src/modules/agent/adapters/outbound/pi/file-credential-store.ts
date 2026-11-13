import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";
import { z } from "zod";

const credentialSchema = z.discriminatedUnion("type", [
	z.looseObject({
		type: z.literal("oauth"),
		access: z.string().min(1),
		refresh: z.string().min(1),
		expires: z.number(),
	}),
	z.strictObject({
		type: z.literal("api_key"),
		key: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
	}),
]);
const credentialFileSchema = z.record(z.string(), credentialSchema);

type CredentialFile = Record<string, Credential>;

// pi-ai の CredentialStore をJSONファイルで実装する。直列化はこのプロセス内だけで、別プロセスとの排他はしない。
export class FileCredentialStore implements CredentialStore {
	private readonly chains = new Map<string, Promise<void>>();
	// ファイルは全プロバイダで1つなので、プロバイダごとの直列化とは別に書き込みも直列化する。
	private writeChain: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credentials = await this.readFile();
		return credentials[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = await this.readFile();
		return Object.entries(credentials).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.enqueue(
			providerId,
			async () => {
				const current = (await this.readFile())[providerId];
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				if (next === undefined) return current;
				await this.update((credentials) => {
					credentials[providerId] = next;
				});
				return next;
			},
			options?.signal,
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.enqueue(
			providerId,
			() =>
				this.update((credentials) => {
					delete credentials[providerId];
				}),
			options?.signal,
		);
	}

	private enqueue<T>(
		providerId: string,
		task: () => Promise<T>,
		signal: AbortSignal | undefined,
	): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous;
			signal?.throwIfAborted();
			return await task();
		})();
		const tail = queued.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(providerId, tail);
		void tail.then(() => {
			if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
		});
		return raceWithAbort(queued, signal);
	}

	private update(mutate: (credentials: CredentialFile) => void): Promise<void> {
		const write = this.writeChain.then(async () => {
			// 別プロバイダの書き込みを消さないよう、書き込む直前に読み直す。
			const credentials = await this.readFile();
			mutate(credentials);
			await this.writeFile(credentials);
		});
		this.writeChain = write.then(
			() => undefined,
			() => undefined,
		);
		return write;
	}

	private async readFile(): Promise<CredentialFile> {
		let text: string;
		try {
			text = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) return {};
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw new Error(`Credential file is not valid JSON: ${this.filePath}`, { cause: error });
		}
		const result = credentialFileSchema.safeParse(value);
		if (!result.success) {
			throw new Error(`Credential file has an invalid shape: ${this.filePath}`, {
				cause: result.error,
			});
		}
		return result.data;
	}

	private async writeFile(credentials: CredentialFile): Promise<void> {
		const directory = path.dirname(this.filePath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		// mkdir の mode は既存ディレクトリと umask に効かないため、明示的に絞る。
		await chmod(directory, 0o700);
		const temporaryPath = path.join(
			directory,
			`.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
		);
		try {
			const handle = await open(temporaryPath, "wx", 0o600);
			try {
				await handle.chmod(0o600);
				await handle.writeFile(`${JSON.stringify(credentials, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, this.filePath);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
	}
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return await promise;
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => {
		aborted.reject(toError(signal.reason));
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function toError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
