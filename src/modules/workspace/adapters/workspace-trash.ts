import { readdirSync, statfsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { LoggerPort } from "../../observability/ports/logger-port";
import type { TrashFolderStatus, WorkspaceStatus } from "../domain/workspace-status";

// ゴミ箱の中身は捨てた日の日付フォルダに置く。保持期間は docs/SPEC.md のゴミ箱の節で定めたもの。
export const TRASH_RETENTION_DAYS = 14;
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

export class WorkspaceTrash {
	readonly #trashDir: string;

	constructor(
		private readonly workspaceDir: string,
		private readonly logger: LoggerPort,
	) {
		this.#trashDir = join(workspaceDir, ".trash");
	}

	// 捨てた日から保持期間の日数が経った日になったら、その日付フォルダを消す。日付でない名前は捨てた日が分からないので残す。
	async prune(now: Date): Promise<void> {
		for (const name of await this.#folderNames()) {
			const deleteOn = deleteDateOf(name);
			if (deleteOn === undefined) {
				this.logger.warn("workspace.trash.unknown_entry", { name });
				continue;
			}
			if (now.getTime() < Date.parse(`${deleteOn}T00:00:00`)) continue;
			await rm(join(this.#trashDir, name), { recursive: true, force: true });
			this.logger.info("workspace.trash.deleted", { folder: name });
		}
	}

	status(): WorkspaceStatus {
		const disk = statfsSync(this.workspaceDir);
		return {
			disk: { totalBytes: disk.blocks * disk.bsize, freeBytes: disk.bavail * disk.bsize },
			trash: this.#trashFolders(),
		};
	}

	#trashFolders(): TrashFolderStatus[] {
		let names: string[];
		try {
			names = readdirSync(this.#trashDir).toSorted();
		} catch (error: unknown) {
			if (isMissing(error)) return [];
			throw error;
		}
		return names.flatMap((name) => {
			const deleteOn = deleteDateOf(name);
			if (deleteOn === undefined) return [];
			return [
				{ date: name, deleteOn, entries: readdirSync(join(this.#trashDir, name)).toSorted() },
			];
		});
	}

	async #folderNames(): Promise<string[]> {
		try {
			return await readdir(this.#trashDir);
		} catch (error: unknown) {
			if (isMissing(error)) return [];
			throw error;
		}
	}
}

function deleteDateOf(name: string): string | undefined {
	if (!DATE_FOLDER_PATTERN.test(name)) return undefined;
	const discarded = Date.parse(`${name}T00:00:00Z`);
	if (Number.isNaN(discarded)) return undefined;
	return new Date(discarded + TRASH_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
