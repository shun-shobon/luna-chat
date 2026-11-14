import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type AtomicWriteOptions = Readonly<{ mode?: number }>;

// 書き込み途中のファイルを読まれないよう、同じディレクトリの一時ファイルへ書いてから置き換える。
export async function writeFileAtomic(
	path: string,
	data: string,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const temporaryPath = temporaryPathFor(path);
	try {
		const handle = await open(temporaryPath, "wx", options.mode);
		try {
			// open の mode は umask で削られるため、指定があれば明示的に合わせる。
			if (options.mode !== undefined) await handle.chmod(options.mode);
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, path);
	} catch (error: unknown) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

export function writeFileAtomicSync(path: string, data: string): void {
	const temporaryPath = temporaryPathFor(path);
	try {
		const descriptor = openSync(temporaryPath, "wx");
		try {
			writeSync(descriptor, data, null, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporaryPath, path);
	} catch (error: unknown) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

function temporaryPathFor(path: string): string {
	return join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
}
