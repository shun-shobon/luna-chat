import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

import type { SendFile } from "../domain/discord-action";
import type { ResolvedSendFile, SendFileResolverPort } from "../ports/send-file-resolver-port";

export class FilesystemSendFileResolver implements SendFileResolverPort {
  async resolve(file: SendFile): Promise<ResolvedSendFile> {
    const resolvedPath = await realpath(file.path);
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile()) {
      throw new Error(`Discord attachment is not a regular file: ${resolvedPath}`);
    }
    await access(resolvedPath, constants.R_OK);

    return {
      path: resolvedPath,
      ...(file.fileName === undefined ? {} : { fileName: file.fileName }),
      ...(file.description === undefined ? {} : { description: file.description }),
    };
  }
}
