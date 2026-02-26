import { describe, expect, it, type Mock, vi } from "vitest";

import type { AiService } from "../ai/application/channel-session-coordinator";

import { startHeartbeatRunner, type HeartbeatCronJobOptions } from "./heartbeat-runner";

describe("startHeartbeatRunner", () => {
  it("JST の毎時 00/30 分で cron ジョブを起動する", () => {
    const generateHeartbeat = vi.fn(async () => undefined);
    const logger = createLoggerStub();
    const capture = createCronCapture();

    startHeartbeatRunner({
      aiService: createAiService(generateHeartbeat),
      createCronJob: capture.createCronJob,
      logger,
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });

    expect(capture.createCronJob).toHaveBeenCalledTimes(1);
    expect(capture.options?.cronTime).toBe("0 0,30 * * * *");
    expect(capture.options?.timeZone).toBe("Asia/Tokyo");
    expect(capture.options?.start).toBe(true);
    expect(capture.options?.waitForCompletion).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Heartbeat runner started.", {
      cronTime: "0 0,30 * * * *",
      timeZone: "Asia/Tokyo",
    });
  });

  it("cron 実行時に heartbeat を呼び出す", async () => {
    const generateHeartbeat = vi.fn(async () => undefined);
    const logger = createLoggerStub();
    const capture = createCronCapture();

    startHeartbeatRunner({
      aiService: createAiService(generateHeartbeat),
      createCronJob: capture.createCronJob,
      logger,
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });

    const options = getCronOptions(capture.options);
    await options.onTick();

    expect(generateHeartbeat).toHaveBeenCalledWith({
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("heartbeat が失敗しても例外を投げずログへ記録する", async () => {
    const generateHeartbeat = vi.fn(async () => {
      throw new Error("heartbeat failed");
    });
    const logger = createLoggerStub();
    const capture = createCronCapture();

    startHeartbeatRunner({
      aiService: createAiService(generateHeartbeat),
      createCronJob: capture.createCronJob,
      logger,
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });

    const options = getCronOptions(capture.options);
    await expect(options.onTick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("Failed to run heartbeat:", expect.any(Error));
  });

  it("stop で cron ジョブを停止する", () => {
    const generateHeartbeat = vi.fn(async () => undefined);
    const logger = createLoggerStub();
    const capture = createCronCapture();

    const runner = startHeartbeatRunner({
      aiService: createAiService(generateHeartbeat),
      createCronJob: capture.createCronJob,
      logger,
      prompt: "HEARTBEAT.mdを確認し、作業を行ってください。",
    });
    runner.stop();

    expect(capture.stop).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Heartbeat runner stopped.");
  });
});

function createAiService(generateHeartbeat: AiService["generateHeartbeat"]): AiService {
  return {
    generateHeartbeat,
    generateReply: async () => undefined,
  };
}

function createLoggerStub(): {
  error: Mock;
  info: Mock;
} {
  return {
    error: vi.fn(),
    info: vi.fn(),
  };
}

function createCronCapture(): {
  createCronJob: Mock<(options: HeartbeatCronJobOptions) => { stop: () => void }>;
  options: HeartbeatCronJobOptions | undefined;
  stop: Mock;
} {
  let options: HeartbeatCronJobOptions | undefined;
  const stop = vi.fn();
  const createCronJob = vi.fn((input: HeartbeatCronJobOptions) => {
    options = input;
    return { stop };
  });

  return {
    createCronJob,
    get options() {
      return options;
    },
    stop,
  };
}

function getCronOptions(options: HeartbeatCronJobOptions | undefined): HeartbeatCronJobOptions {
  if (!options) {
    throw new Error("Cron options were not captured.");
  }

  return options;
}
