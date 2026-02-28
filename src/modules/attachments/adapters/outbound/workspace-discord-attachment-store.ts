import { access, mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type {
  DiscordAttachmentInput,
  DiscordAttachmentStore,
} from "../../ports/discord-attachment-store";

const ATTACHMENTS_DIR_NAME = "discord-attachments";

export class WorkspaceDiscordAttachmentStore implements DiscordAttachmentStore {
  constructor(private readonly workspaceDir: string) {}

  async saveAttachment(input: DiscordAttachmentInput): Promise<string> {
    const attachmentsDir = resolve(this.workspaceDir, ATTACHMENTS_DIR_NAME);
    await mkdir(attachmentsDir, { recursive: true });

    const filePath = resolve(attachmentsDir, buildAttachmentFileName(input));
    if (await exists(filePath)) {
      return filePath;
    }

    const response = await fetch(input.url);
    if (!response.ok) {
      throw new Error(`attachment download failed: ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(filePath, bytes);
    return filePath;
  }
}

function buildAttachmentFileName(input: DiscordAttachmentInput): string {
  const safeAttachmentId = sanitizeAttachmentId(input.id);
  const extension = resolveAttachmentExtension(input.name, input.url);
  return `${safeAttachmentId}${extension}`;
}

function sanitizeAttachmentId(rawAttachmentId: string): string {
  const sanitized = rawAttachmentId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (sanitized.length > 0) {
    return sanitized;
  }

  return "attachment";
}

function resolveAttachmentExtension(name: string | null, url: string): string {
  const fromName = normalizeExtension(extname(name ?? ""));
  if (fromName.length > 0) {
    return fromName;
  }

  try {
    const parsedUrl = new URL(url);
    return normalizeExtension(extname(parsedUrl.pathname));
  } catch {
    return "";
  }
}

function normalizeExtension(extension: string): string {
  const lowered = extension.toLowerCase();
  if (!/^\.[a-z0-9]{1,16}$/.test(lowered)) {
    return "";
  }
  return lowered;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
