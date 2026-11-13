import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { z } from "zod";

import type { LoggerPort } from "../../observability/ports/logger-port";
import type { ToolExecution, ToolOrigin } from "../domain/tool";
import { defineTool } from "../ports/tool-provider";
import type { ToolProvider } from "../ports/tool-provider";
import { createToolSet } from "./tool-set";

const origin: ToolOrigin = { kind: "event", eventId: "event-1", eventType: "test.v1" };

describe("createToolSet", () => {
	it("定義をAgentToolへ変換し、実行元とsignalを渡して結果をJSON文字列で返す", async () => {
		const execute = vi.fn(async (input: { value: string }, _execution: ToolExecution) => ({
			echoed: input.value,
		}));
		const logger = createLogger();
		const toolSet = createToolSet([provider([echoTool(execute)])], logger);
		const [tool] = toolSet.bind({ ownerId: "owner-1", origin });
		const signal = new AbortController().signal;

		expect(tool).toMatchObject({ name: "echo", description: "Echo the value." });
		expect(tool?.parameters).toEqual({
			type: "object",
			properties: { value: { type: "string", minLength: 1 } },
			required: ["value"],
			additionalProperties: false,
		});
		await expect(tool?.execute({ value: "hi" }, signal)).resolves.toEqual({
			text: JSON.stringify({ echoed: "hi" }),
			images: [],
			isError: false,
		});
		expect(execute).toHaveBeenCalledWith({ value: "hi" }, { ownerId: "owner-1", origin, signal });
		expect(logger.log).toHaveBeenCalledWith(
			"info",
			"tool.succeeded",
			{},
			{ ownerId: "owner-1", target: { value: "hi" }, toolName: "echo" },
			{ input: { value: "hi" }, result: { echoed: "hi" } },
		);
	});

	it("複数のプロバイダーで同じ名前のツールがあれば作成時に拒否する", () => {
		expect(() =>
			createToolSet([provider([echoTool(vi.fn())]), provider([echoTool(vi.fn())])], createLogger()),
		).toThrow("Duplicate tool name: echo");
	});

	it("不正な入力は実行せず、検証エラーをisErrorで返して記録する", async () => {
		const execute = vi.fn(async () => null);
		const logger = createLogger();
		const [tool] = createToolSet([provider([echoTool(execute)])], logger).bind({
			ownerId: "owner-1",
			origin,
		});

		const result = await tool?.execute({ value: "", extra: true }, new AbortController().signal);

		expect(result?.isError).toBe(true);
		expect(result?.text).toContain("value");
		expect(result?.text).toContain("extra");
		expect(execute).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith(
			"warn",
			"tool.failed",
			{},
			{ error: result?.text, ownerId: "owner-1", toolName: "echo" },
			{ input: { value: "", extra: true } },
		);
	});

	it.each([
		["Error", new Error("port failed"), "port failed"],
		["Error以外の値", "plain failure", "plain failure"],
	])("実行中の例外(%s)をisErrorのメッセージとして返す", async (_label, thrown, message) => {
		const logger = createLogger();
		const [tool] = createToolSet(
			[
				provider([
					echoTool(async () => {
						// oxlint-disable-next-line typescript/only-throw-error -- Error以外を投げる実装でもメッセージを返せるかを確かめる。
						throw thrown;
					}),
				]),
			],
			logger,
		).bind({ ownerId: "owner-1", origin });

		await expect(tool?.execute({ value: "hi" }, new AbortController().signal)).resolves.toEqual({
			text: message,
			images: [],
			isError: true,
		});
		expect(logger.log).toHaveBeenCalledWith(
			"warn",
			"tool.failed",
			{},
			{ error: message, ownerId: "owner-1", toolName: "echo" },
			{ input: { value: "hi" } },
		);
	});

	it("releaseを全プロバイダーへ渡し、失敗したプロバイダーを記録して残りも解放する", async () => {
		const failure = new Error("release failed");
		const firstRelease = vi.fn(async () => {
			throw failure;
		});
		const secondRelease = vi.fn(async () => undefined);
		const first: ToolProvider = { definitions: [], release: firstRelease };
		const second: ToolProvider = { definitions: [], release: secondRelease };
		const logger = createLogger();

		await createToolSet([first, second], logger).release("owner-1");

		expect(firstRelease).toHaveBeenCalledWith("owner-1");
		expect(secondRelease).toHaveBeenCalledWith("owner-1");
		expect(logger.log).toHaveBeenCalledWith(
			"warn",
			"tool.provider_release_failed",
			{},
			{ error: failure, ownerId: "owner-1", providerIndex: 0 },
		);
	});
});

function echoTool(
	execute: (input: { value: string }, execution: ToolExecution) => Promise<unknown>,
) {
	return defineTool({
		name: "echo",
		description: "Echo the value.",
		inputSchema: z.strictObject({ value: z.string().min(1) }),
		parseInput: (input) => input,
		execute,
		describeTarget: (input) => ({ value: input.value }),
	});
}

function provider(definitions: ToolProvider["definitions"]): ToolProvider {
	return { definitions, release: async () => {} };
}

function createLogger(): { log: Mock<LoggerPort["log"]> } {
	return { log: vi.fn() };
}
