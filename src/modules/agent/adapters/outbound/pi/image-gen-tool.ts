import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

import type { JsonObject } from "../../../../../shared/json";
import type {
	AgentImage,
	AgentTool,
	AgentToolResult,
} from "../../../ports/outbound/agent-session-port";
import type { ChatGptBackend } from "./chatgpt-backend";

// Codex の codex-rs/ext/image-generation に合わせる。
const IMAGE_MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
const GENERATED_IMAGES_DIR = "generated_images";
const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BASE64_BYTES = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;
const MAX_OUTPUT_HINT_BYTES = 1024;

// imagegen_description.md から、Luna にない code-mode 向けの2行を除き、ツール名を image_gen に置き換えた。
const IMAGE_GEN_DESCRIPTION = `The \`image_gen\` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:

- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.
- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).

Guidelines:
- Set \`transparent_background\` to true when the request calls for a transparent background, including background removal or a cutout; set it to false otherwise. For edits, preserve existing transparency unless the user asks to change it.
- Omit both \`referenced_image_paths\` and \`num_last_images_to_include\` when generating a brand new image.
- For edits, use \`referenced_image_paths\` when every target image has a local file path.
- If you have not seen a local image yet, use \`view_image\` to inspect it before editing.
- Use \`num_last_images_to_include\` only when at least one target image has no local file path.
- Set \`num_last_images_to_include\` to the smallest number of recent conversation images that includes every target image, up to 5.
- Never provide both \`referenced_image_paths\` and \`num_last_images_to_include\`.
- If neither mechanism can include every target image, ask the user to attach the missing images again.
- Directly generate the image without reconfirmation or clarification unless required images must be attached again.
- Always use this tool for image editing unless the user explicitly requests otherwise. Do not use the \`python\` tool for image editing unless specifically instructed.
`;

// ImagegenArgs から schemars が作るスキーマを手で写したもの。GIF出力は有効にしていないため gif は含めない。
const IMAGE_GEN_PARAMETERS: JsonObject = {
	type: "object",
	required: ["prompt"],
	properties: {
		prompt: { type: "string" },
		transparent_background: {
			description: "Whether the output should have a transparent background. Defaults to false.",
			default: false,
			type: "boolean",
		},
		referenced_image_paths: {
			type: "array",
			items: { type: "string" },
			maxItems: MAX_EDIT_IMAGES,
		},
		num_last_images_to_include: {
			type: "integer",
			minimum: 1,
			maximum: MAX_EDIT_IMAGES,
		},
	},
	additionalProperties: false,
};

// Codex は gif を引数として受け取ったうえで、無効なセッションでは専用のエラーを返す。
const imageGenArgsSchema = z.strictObject({
	prompt: z.string(),
	gif: z.unknown().optional(),
	transparent_background: z.boolean().optional(),
	referenced_image_paths: z
		.array(z.string().refine((value) => path.isAbsolute(value), "path must be absolute"))
		.optional(),
	num_last_images_to_include: z.number().int().nonnegative().optional(),
});
type ImageGenArgs = z.infer<typeof imageGenArgsSchema>;

const imageResponseSchema = z.looseObject({
	created: z.number(),
	data: z.array(
		z.looseObject({
			b64_json: z.string().min(1),
			generation_id: z.string().nullish(),
		}),
	),
});

type ImageReference = Readonly<{ image_url: string }>;

type ImageRequest = Readonly<{
	path: "codex/images/generations" | "codex/images/edits";
	body: Readonly<Record<string, unknown>>;
}>;

class ToolInputError extends Error {}

export type ImageGenToolOptions = Readonly<{
	backend: ChatGptBackend;
	// 生成した画像を保存するワークスペース。Codex は cwd/generated_images/ に保存する。
	cwd: string;
	// num_last_images_to_include で参照する会話中の画像。
	conversation: () => readonly Message[];
}>;

export function createImageGenTool(options: ImageGenToolOptions): AgentTool {
	return {
		name: "image_gen",
		description: IMAGE_GEN_DESCRIPTION,
		parameters: IMAGE_GEN_PARAMETERS,
		async execute(argumentsValue, signal) {
			const parsed = imageGenArgsSchema.safeParse(argumentsValue);
			if (!parsed.success) return failure(z.prettifyError(parsed.error));
			const args = parsed.data;
			if (args.gif !== undefined) return failure("GIF output is unavailable in this session.");

			let request: ImageRequest;
			try {
				request = await buildRequest(args, options.conversation);
			} catch (error) {
				if (error instanceof ToolInputError) return failure(error.message);
				throw error;
			}

			let result: string;
			try {
				const response = await options.backend.request({
					method: "POST",
					path: request.path,
					body: request.body,
					schema: imageResponseSchema,
					signal,
				});
				const first = response.data[0];
				if (first === undefined) return failure("image generation returned no image data");
				result = first.b64_json.trim();
			} catch (error) {
				signal.throwIfAborted();
				return failure(
					`image generation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			const image: AgentImage = { data: result, mimeType: imageFormat(result).mimeType };
			try {
				const savedPath = await saveGeneratedImage(options.cwd, randomUUID(), result);
				return { text: outputHint(savedPath), images: [image], isError: false };
			} catch (error) {
				// Codex と同じく、保存に失敗しても生成した画像は返す。
				return {
					text: `Failed to save generated image: ${error instanceof Error ? error.message : String(error)}`,
					images: [image],
					isError: false,
				};
			}
		},
	};
}

async function buildRequest(
	args: ImageGenArgs,
	conversation: () => readonly Message[],
): Promise<ImageRequest> {
	const common = {
		prompt: args.prompt,
		background: args.transparent_background === true ? "transparent" : "opaque",
		model: IMAGE_MODEL,
		quality: "auto",
		size: "auto",
	};
	const paths = args.referenced_image_paths ?? [];
	if (paths.length > MAX_EDIT_IMAGES) {
		throw new ToolInputError(
			`\`referenced_image_paths\` must contain at most ${MAX_EDIT_IMAGES} paths`,
		);
	}
	const count = args.num_last_images_to_include;
	if (paths.length === 0 && count === undefined) {
		return { path: "codex/images/generations", body: common };
	}
	if (paths.length > 0 && count !== undefined) {
		throw new ToolInputError(
			"provide only one of `referenced_image_paths` or `num_last_images_to_include`",
		);
	}
	let images: ImageReference[];
	if (count === undefined) {
		images = await Promise.all(paths.map((imagePath) => loadInputImage(imagePath)));
	} else {
		if (count < 1 || count > MAX_EDIT_IMAGES) {
			throw new ToolInputError(
				`\`num_last_images_to_include\` must be between 1 and ${MAX_EDIT_IMAGES}`,
			);
		}
		images = recentImages(conversation(), count);
	}
	return { path: "codex/images/edits", body: { images, ...common } };
}

async function loadInputImage(imagePath: string): Promise<ImageReference> {
	let bytes: Buffer;
	try {
		bytes = await readFile(imagePath);
	} catch (error) {
		throw new ToolInputError(
			`unable to read referenced image at \`${imagePath}\`: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const mimeType = detectImageMimeType(bytes);
	if (mimeType == null) {
		throw new ToolInputError(
			`unable to process referenced image at \`${imagePath}\`: unsupported image format`,
		);
	}
	return { image_url: `data:${mimeType};base64,${bytes.toString("base64")}` };
}

// Codex は画像をデコードして送るが、依存を増やさないため送れる形式をシグネチャで判定する。
function detectImageMimeType(bytes: Buffer): string | null {
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
	const header = bytes.subarray(0, 6).toString("latin1");
	if (header === "GIF87a" || header === "GIF89a") return "image/gif";
	if (
		bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
		bytes.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

// 会話の新しい方から画像を数え、古い順に並べ直して返す。
function recentImages(messages: readonly Message[], count: number): ImageReference[] {
	const images: ImageReference[] = [];
	for (const message of messages.toReversed()) {
		if (message.role !== "user" && message.role !== "toolResult") continue;
		if (typeof message.content === "string") continue;
		for (const part of message.content.toReversed()) {
			if (part.type !== "image") continue;
			images.push({ image_url: `data:${part.mimeType};base64,${part.data}` });
			if (images.length === count) return images.toReversed();
		}
	}
	throw new ToolInputError(
		`requested the last ${count} conversation images, but only ${images.length} were available`,
	);
}

function imageFormat(base64: string): { mimeType: string; extension: string } {
	// GIF のヘッダ "GIF87a" / "GIF89a" を base64 にしたもの。
	if (base64.startsWith("R0lGODdh") || base64.startsWith("R0lGODlh")) {
		return { mimeType: "image/gif", extension: "gif" };
	}
	return { mimeType: "image/png", extension: "png" };
}

async function saveGeneratedImage(cwd: string, callId: string, base64: string): Promise<string> {
	if (base64.length > MAX_GENERATED_IMAGE_BASE64_BYTES) {
		throw new Error("generated image exceeds the executor file size limit");
	}
	const bytes = Buffer.from(base64, "base64");
	if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
		throw new Error("generated image exceeds the executor file size limit");
	}
	const outputDir = path.join(cwd, GENERATED_IMAGES_DIR);
	await mkdir(outputDir, { recursive: true });
	// シンボリックリンクを辿ってワークスペースの外へ書かないようにする。
	const stats = await lstat(outputDir);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error("generated image directory is not a real directory");
	}
	const outputPath = path.join(
		outputDir,
		`${sanitizeFileStem(callId)}.${imageFormat(base64).extension}`,
	);
	// 既存のハードリンク越しにワークスペース外のファイルを上書きしないよう、新規作成に限る。
	await writeFile(outputPath, bytes, { flag: "wx" });
	return outputPath;
}

function sanitizeFileStem(value: string): string {
	const sanitized = value.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
	return sanitized === "" ? "generated_image" : sanitized;
}

// Codex の文言のうち「すでにユーザーに表示済み」の一文は、画像を自動では投稿しない Luna では誤りになるため除いた。
function outputHint(savedPath: string): string {
	const hint = `Generated images are saved to ${path.dirname(savedPath)} as ${savedPath} by default.
If you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.`;
	return Buffer.byteLength(hint) <= MAX_OUTPUT_HINT_BYTES ? hint : "";
}

function failure(message: string): AgentToolResult {
	return { text: message, images: [], isError: true };
}
