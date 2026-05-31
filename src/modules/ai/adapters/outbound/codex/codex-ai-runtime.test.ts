import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const processHandle = {
    close: vi.fn(async () => undefined),
    onError: vi.fn(),
    onExit: vi.fn(),
    onLine: vi.fn(),
    writeLine: vi.fn(),
  };
  const rpcClient = {
    close: vi.fn(async () => undefined),
    notifyInitialized: vi.fn(),
    onNotification: vi.fn(() => {
      return () => undefined;
    }),
    request: vi.fn(),
  };

  return {
    processHandle,
    rpcClient,
    startStdioProcess: vi.fn(() => processHandle),
  };
});

vi.mock("./stdio-process", () => {
  return {
    startStdioProcess: mocks.startStdioProcess,
  };
});

vi.mock("./json-rpc-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./json-rpc-client")>();

  return {
    ...actual,
    createJsonRpcClient: vi.fn(() => mocks.rpcClient),
  };
});

import { CodexAiRuntime } from "./codex-ai-runtime";

describe("CodexAiRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpcClient.request.mockResolvedValue({
      thread: {
        id: "thread-1",
      },
    });
  });

  it("永続化される thread として開始する", async () => {
    const runtime = new CodexAiRuntime({
      codexHomeDir: "/tmp/codex",
      command: ["codex", "app-server", "--listen", "stdio://"],
      cwd: "/tmp/workspace",
    });

    await expect(
      runtime.startThread({
        developerRolePrompt: "developer prompt",
        instructions: "base instructions",
      }),
    ).resolves.toBe("thread-1");

    expect(mocks.rpcClient.request).toHaveBeenCalledWith("thread/start", {
      approvalPolicy: "never",
      baseInstructions: "base instructions",
      cwd: "/tmp/workspace",
      developerInstructions: "developer prompt",
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
  });
});
