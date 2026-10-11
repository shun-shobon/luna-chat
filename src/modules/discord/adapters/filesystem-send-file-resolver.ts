import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

import type { SendFile } from "../domain/discord-action";

export async function resolveSendFile(file: SendFile): Promise<SendFile> {
	const resolvedPath = await realpath(file.path);
	const metadata = await stat(resolvedPath);
	if (!metadata.isFile()) {
		throw new Error(`Discord attachment is not a regular file: ${resolvedPath}`);
	}
	await access(resolvedPath, constants.R_OK);
	return { ...file, path: resolvedPath };
}
