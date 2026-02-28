import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendAttachmentMarkers, WorkspaceDiscordAttachmentStore } from "./index";

describe("appendAttachmentMarkers", () => {
  it("添付がない場合は本文をそのまま返す", () => {
    expect(appendAttachmentMarkers("hello", [])).toBe("hello");
  });

  it("複数添付を本文末尾に1行で空白区切り追加する", () => {
    expect(appendAttachmentMarkers("hello", ["/tmp/a1.png", "/tmp/a2.jpg"])).toBe(
      "hello\n<attachment:/tmp/a1.png> <attachment:/tmp/a2.jpg>",
    );
  });
});

describe("WorkspaceDiscordAttachmentStore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attachmentId.ext 形式で保存し、既存ファイルを再利用する", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "luna-attachments-"));
    try {
      const fetchMock = vi.fn(async () => {
        return new Response("image-bytes", {
          status: 200,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const store = new WorkspaceDiscordAttachmentStore(workspaceDir);
      const first = await store.saveAttachment({
        id: "attachment-1",
        name: "cat.PNG",
        url: "https://example.com/cat.png",
      });
      const second = await store.saveAttachment({
        id: "attachment-1",
        name: "cat.PNG",
        url: "https://example.com/cat.png",
      });

      expect(first).toBe(second);
      expect(first).toContain("discord-attachments/attachment-1.png");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("ファイル名に拡張子がない場合はURLから推定する", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "luna-attachments-"));
    try {
      vi.stubGlobal("fetch", async () => {
        return new Response("image-bytes", {
          status: 200,
        });
      });

      const store = new WorkspaceDiscordAttachmentStore(workspaceDir);
      const savedPath = await store.saveAttachment({
        id: "attachment-2",
        name: null,
        url: "https://example.com/path/to/image.webp?size=2048",
      });

      expect(savedPath).toContain("discord-attachments/attachment-2.webp");
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("IDに危険文字が含まれても安全なファイル名へ置換する", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "luna-attachments-"));
    try {
      vi.stubGlobal("fetch", async () => {
        return new Response("image-bytes", {
          status: 200,
        });
      });

      const store = new WorkspaceDiscordAttachmentStore(workspaceDir);
      const savedPath = await store.saveAttachment({
        id: "../danger",
        name: "x.png",
        url: "https://example.com/x.png",
      });

      expect(savedPath).toContain("discord-attachments/___danger.png");
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("既存ファイルがあればダウンロードしない", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "luna-attachments-"));
    try {
      const dir = join(workspaceDir, "discord-attachments");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "already-there.png"), "bytes");
      const fetchMock = vi.fn(async () => {
        return new Response("image-bytes", {
          status: 200,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const store = new WorkspaceDiscordAttachmentStore(workspaceDir);
      const savedPath = await store.saveAttachment({
        id: "already-there",
        name: "x.png",
        url: "https://example.com/x.png",
      });

      expect(savedPath).toContain("discord-attachments/already-there.png");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });
});
