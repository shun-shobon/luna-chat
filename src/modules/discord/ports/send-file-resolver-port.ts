import type { SendFile } from "../domain/discord-action";

export type ResolvedSendFile = Readonly<{
  path: string;
  fileName?: string | undefined;
  description?: string | undefined;
}>;

export interface SendFileResolverPort {
  resolve(file: SendFile): Promise<ResolvedSendFile>;
}
