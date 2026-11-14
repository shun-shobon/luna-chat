import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatGptBackend } from "./chatgpt-backend";
import { createImageGenTool } from "./image-gen-tool";

const fetchMock = vi.fn<typeof fetch>();
const ACCESS_TOKEN = `header.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
).toString("base64")}.signature`;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_BASE64 = PNG_BYTES.toString("base64");

function imageResponse(b64: string): Response {
	return Response.json({ created: 1, data: [{ b64_json: b64 }], background: "opaque" });
}

function hangUntilAborted(
	_input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => {
			const reason: unknown = init.signal?.reason;
			reject(reason instanceof Error ? reason : new Error(String(reason)));
		});
	});
}

function requestBody(index: number): unknown {
	const body = fetchMock.mock.calls[index]?.[1]?.body;
	if (typeof body !== "string") throw new TypeError("request body is not a string");
	const parsed: unknown = JSON.parse(body);
	return parsed;
}

describe("image_gen", () => {
	let scratchDir: string;
	let conversation: Message[];
	const signal = new AbortController().signal;

	async function createTool(options: { loggedIn?: boolean; timeoutMs?: number } = {}) {
		const credentials = new InMemoryCredentialStore();
		if (options.loggedIn ?? true) {
			await credentials.modify("openai-codex", async () => ({
				type: "oauth",
				access: ACCESS_TOKEN,
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				accountId: "account-1",
			}));
		}
		const models = createModels({ credentials });
		models.setProvider(openaiCodexProvider());
		return createImageGenTool({
			backend: new ChatGptBackend({ models, timeoutMs: options.timeoutMs ?? 1000 }),
			scratchDir,
			conversation: () => conversation,
		});
	}

	beforeEach(async () => {
		scratchDir = await mkdtemp(path.join(tmpdir(), "luna-image-gen-"));
		conversation = [];
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await rm(scratchDir, { recursive: true, force: true });
	});

	it("新規生成をimages/generationsへ送り、PNGを保存してパスと画像を返す", async () => {
		fetchMock.mockResolvedValueOnce(imageResponse(`${PNG_BASE64}\n`));

		const result = await (await createTool()).execute({ prompt: "a fox" }, signal);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://chatgpt.com/backend-api/codex/images/generations",
		);
		expect(requestBody(0)).toEqual({
			prompt: "a fox",
			background: "opaque",
			model: "gpt-image-2",
			quality: "auto",
			size: "auto",
		});
		const outputDir = path.join(scratchDir, "generated_images");
		const files = await readdir(outputDir);
		expect(files).toEqual([expect.stringMatching(/^[\da-f-]+\.png$/u)]);
		const savedPath = path.join(outputDir, files[0] ?? "");
		await expect(readFile(savedPath)).resolves.toEqual(PNG_BYTES);
		expect(result).toEqual({
			text: `Generated images are saved to ${outputDir} as ${savedPath} by default.\nThis is the session's scratch directory, which the system clears eventually. To keep an image, copy it into the workspace and leave the original in place unless the user explicitly asks you to delete it.`,
			images: [{ data: PNG_BASE64, mimeType: "image/png" }],
			isError: false,
		});
	});

	it("GIFの応答はgifとして保存し、透過指定を送る", async () => {
		const gif = Buffer.from("GIF89a-data").toString("base64");
		fetchMock.mockResolvedValueOnce(imageResponse(gif));

		const result = await (
			await createTool()
		).execute({ prompt: "a fox", transparent_background: true }, signal);

		expect(requestBody(0)).toMatchObject({ background: "transparent" });
		expect(result.images).toEqual([{ data: gif, mimeType: "image/gif" }]);
		await expect(readdir(path.join(scratchDir, "generated_images"))).resolves.toEqual([
			expect.stringMatching(/\.gif$/u),
		]);
	});

	it("referenced_image_pathsの画像をdata URLにしてimages/editsへ送る", async () => {
		const imagePath = path.join(scratchDir, "input.png");
		await writeFile(imagePath, PNG_BYTES);
		fetchMock.mockResolvedValueOnce(imageResponse(PNG_BASE64));

		await (
			await createTool()
		).execute({ prompt: "add a hat", referenced_image_paths: [imagePath] }, signal);

		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/images/edits");
		expect(requestBody(0)).toEqual({
			images: [{ image_url: `data:image/png;base64,${PNG_BASE64}` }],
			prompt: "add a hat",
			background: "opaque",
			model: "gpt-image-2",
			quality: "auto",
			size: "auto",
		});
	});

	it("num_last_images_to_includeで会話の新しい画像から古い順に送る", async () => {
		conversation = [
			{
				role: "user",
				content: [
					{ type: "image", data: "old", mimeType: "image/png" },
					{ type: "text", text: "look" },
				],
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "view_image",
				content: [
					{ type: "image", data: "first", mimeType: "image/jpeg" },
					{ type: "image", data: "second", mimeType: "image/webp" },
				],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "edit them", timestamp: 0 },
		];
		fetchMock.mockResolvedValueOnce(imageResponse(PNG_BASE64));

		await (await createTool()).execute({ prompt: "merge", num_last_images_to_include: 2 }, signal);

		expect(requestBody(0)).toMatchObject({
			images: [
				{ image_url: "data:image/jpeg;base64,first" },
				{ image_url: "data:image/webp;base64,second" },
			],
		});
	});

	it("参照画像の指定が不正なら送らずにエラーを返す", async () => {
		const textPath = path.join(scratchDir, "note.txt");
		await writeFile(textPath, "not an image");
		const tool = await createTool();

		const results = await Promise.all([
			tool.execute(
				{ prompt: "x", referenced_image_paths: [textPath], num_last_images_to_include: 1 },
				signal,
			),
			tool.execute({ prompt: "x", num_last_images_to_include: 6 }, signal),
			tool.execute({ prompt: "x", num_last_images_to_include: 1 }, signal),
			tool.execute({ prompt: "x", referenced_image_paths: [textPath] }, signal),
			tool.execute(
				{ prompt: "x", referenced_image_paths: [path.join(scratchDir, "none.png")] },
				signal,
			),
			tool.execute({ prompt: "x", referenced_image_paths: ["relative.png"] }, signal),
			tool.execute(
				{ prompt: "x", referenced_image_paths: Array.from({ length: 6 }, () => textPath) },
				signal,
			),
			tool.execute({ prompt: "x", gif: {} }, signal),
			tool.execute({ prompt: "x", extra: true }, signal),
		]);

		expect(results.every((result) => result.isError)).toBe(true);
		expect(results.map((result) => result.text.split("\n")[0])).toEqual([
			"provide only one of `referenced_image_paths` or `num_last_images_to_include`",
			"`num_last_images_to_include` must be between 1 and 5",
			"requested the last 1 conversation images, but only 0 were available",
			`unable to process referenced image at \`${textPath}\`: unsupported image format`,
			expect.stringContaining("unable to read referenced image"),
			expect.stringContaining("path must be absolute"),
			"`referenced_image_paths` must contain at most 5 paths",
			"GIF output is unavailable in this session.",
			expect.stringContaining("Unrecognized key"),
		]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("HTTPエラー・タイムアウト・不正な応答・資格情報なしをツールのエラーとして返す", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("usage limit", { status: 429 }))
			.mockImplementationOnce(hangUntilAborted)
			.mockResolvedValueOnce(Response.json({ created: 1, data: [] }))
			.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG_BASE64 }] }));

		const httpError = await (await createTool()).execute({ prompt: "x" }, signal);
		const timedOut = await (await createTool({ timeoutMs: 20 })).execute({ prompt: "x" }, signal);
		const empty = await (await createTool()).execute({ prompt: "x" }, signal);
		const invalid = await (await createTool()).execute({ prompt: "x" }, signal);
		const loggedOut = await (
			await createTool({ loggedIn: false })
		).execute({ prompt: "x" }, signal);

		expect(httpError).toMatchObject({
			isError: true,
			text: expect.stringMatching(/^image generation failed: .*429.*usage limit/u),
		});
		expect(timedOut).toMatchObject({ isError: true, text: expect.stringContaining("timed out") });
		expect(empty).toEqual({
			text: "image generation returned no image data",
			images: [],
			isError: true,
		});
		expect(invalid).toMatchObject({ isError: true, text: expect.stringContaining("unexpected") });
		expect(loggedOut).toEqual({
			text: "image generation failed: ChatGPT login is required",
			images: [],
			isError: true,
		});
		await expect(readdir(scratchDir)).resolves.toEqual([]);
	});

	it("保存先がシンボリックリンクなら保存せず、生成した画像だけ返す", async () => {
		const outside = path.join(scratchDir, "outside");
		await mkdir(outside);
		await symlink(outside, path.join(scratchDir, "generated_images"));
		fetchMock.mockResolvedValueOnce(imageResponse(PNG_BASE64));

		const result = await (await createTool()).execute({ prompt: "x" }, signal);

		expect(result).toEqual({
			text: "Failed to save generated image: generated image directory is not a real directory",
			images: [{ data: PNG_BASE64, mimeType: "image/png" }],
			isError: false,
		});
		await expect(readdir(outside)).resolves.toEqual([]);
	});

	it("呼び出し元の中断は例外としてそのまま返す", async () => {
		const controller = new AbortController();
		fetchMock.mockImplementationOnce((input, init) => {
			const pending = hangUntilAborted(input, init);
			controller.abort(new Error("stopped"));
			return pending;
		});

		await expect((await createTool()).execute({ prompt: "x" }, controller.signal)).rejects.toThrow(
			"stopped",
		);
	});
});
