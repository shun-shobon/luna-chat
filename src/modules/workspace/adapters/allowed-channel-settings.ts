import { stat } from "node:fs/promises";

import { writeFileAtomic } from "../../../shared/atomic-file";
import { SerialQueue } from "../../../shared/serial-queue";
import { readWorkspaceConfig, serializeWorkspaceConfig } from "./config-toml";

export type AllowedChannelChange = "add" | "remove";

export class AllowedChannelSettings {
	readonly #ids: Set<string>;
	readonly #queue = new SerialQueue();

	constructor(
		private readonly configPath: string,
		initialIds: readonly string[],
	) {
		this.#ids = new Set(initialIds);
	}

	get ids(): ReadonlySet<string> {
		return this.#ids;
	}

	change(action: AllowedChannelChange, channelId: string): Promise<boolean> {
		return this.#queue.run(async () => {
			const config = await readWorkspaceConfig(this.configPath);
			const ids = new Set(config.discord.allowedChannelIds);
			const changed = action === "add" ? !ids.has(channelId) : ids.has(channelId);
			if (changed) {
				if (action === "add") ids.add(channelId);
				else ids.delete(channelId);
				config.discord.allowedChannelIds = [...ids];
				const { mode } = await stat(this.configPath);
				await writeFileAtomic(this.configPath, serializeWorkspaceConfig(config), {
					mode: mode & 0o777,
				});
			}
			this.#ids.clear();
			for (const id of ids) this.#ids.add(id);
			return changed;
		});
	}
}
