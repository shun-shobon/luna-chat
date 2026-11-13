import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

import type { JsonObject } from "../../../../../shared/json";
import type { AgentTool, AgentToolResult } from "../../../ports/outbound/agent-session-port";
import type { ChatGptBackend } from "./chatgpt-backend";

// Codex の codex-rs/ext/web-search に合わせる。
const MAX_SEARCH_ERROR_BYTES = 1024;
const ASSISTANT_CONTEXT_TOKEN_LIMIT = 1000;
const APPROX_BYTES_PER_TOKEN = 4;

// web_run_description.md をそのまま使う。ツール名だけ Luna の web_run に置き換えた。
const WEB_RUN_DESCRIPTION = `Tool for accessing the internet.


---

## Examples of different commands available in this tool

Examples of different commands available in this tool:
* \`search_query\`: {"search_query": [{"q": "What is the capital of France?"}, {"q": "What is the capital of belgium?"}]}. Searches the internet for a given query (and optionally with a domain or recency filter)
* \`image_query\`: {"image_query":[{"q": "waterfalls"}]}.
* \`open\`: {"open": [{"ref_id": "turn0search0"}, {"ref_id": "https://www.openai.com", "lineno": 120}]}
* \`click\`: {"click": [{"ref_id": "turn0fetch3", "id": 17}]}
* \`find\`: {"find": [{"ref_id": "turn0fetch3", "pattern": "Annie Case"}]}
* \`screenshot\`: {"screenshot": [{"ref_id": "turn1view0", "pageno": 0}, {"ref_id": "turn1view0", "pageno": 3}]}
* \`finance\`: {"finance":[{"ticker":"AMD","type":"equity","market":"USA"}]}, {"finance":[{"ticker":"BTC","type":"crypto","market":""}]}
* \`weather\`: {"weather":[{"location":"San Francisco, CA"}]}
* \`sports\`: {"sports":[{"fn":"standings","league":"nfl"}, {"fn":"schedule","league":"nba","team":"GSW","date_from":"2025-02-24"}]}
* \`time\`: {"time":[{"utc_offset":"+03:00"}]}

---

## Usage hints
To use this tool efficiently:
* Use multiple commands and queries in one call to get more results faster; e.g. {"search_query": [{"q": "bitcoin news"}], "finance":[{"ticker":"BTC","type":"crypto","market":""}], "find": [{"ref_id": "turn0search0", "pattern": "Annie Case"}, {"ref_id": "turn0search1", "pattern": "John Smith"}]}
* Use "response_length" to control the number of results returned by this tool, omit it if you intend to pass "short" in
* Only write required parameters; do not write empty lists or nulls where they could be omitted.
* \`search_query\` must have length at most 4 in each call. If it has length > 3, response_length must be medium or long
* If you find yourself in a situation where you accidentally call the \`web_run\` tool, it's best just to send an empty query: {"search_query": [{"q": ""}]}.

---

## Decision boundary

If the user makes an explicit request to search the internet, find latest information, look up, etc (or to not do so), you must obey their request.
When you make an assumption, always consider whether it is temporally stable; i.e. whether there's even a small (>10%) chance it has changed. If it is unstable, you must verify with browsing the internet for verification.

<situations_where_you_must_browse_the_internet>
Below is a list of scenarios where browsing the internet MUST be used. PAY CLOSE ATTENTION: you MUST browse the internet in these cases. If you're unsure or on the fence, you MUST bias towards browsing the internet.
- The information could have changed recently: for example news; prices; laws; schedules; product specs; sports scores; economic indicators; political/public/company figures (e.g. the question relates to 'the president of country A' or 'the CEO of company B', which might change over time); rules; regulations; standards; software libraries that could be updated; exchange rates; recommendations (i.e., recommendations about various topics or things might be informed by what currently exists / is popular / is safe / is unsafe / is in the zeitgeist / etc.); and many many many more categories -- again, if you're on the fence, you MUST browse the internet!
  - For news queries, prioritize more recent events, ensuring you compare publish dates and the date that the event happened.
- The user is seeking recommendations that could lead them to spend substantial time or money -- researching products, restaurants, travel plans, etc.
- The user wants (or would benefit from) direct quotes, links, or precise source attribution.
- A specific page, paper, dataset, PDF, or site is referenced and you haven't been given its contents.
- You're unsure about a fact, the topic is niche or emerging, or you suspect there's at least a 10% chance you will incorrectly recall it
- High-stakes accuracy matters (medical, legal, financial guidance). For these you generally should search by default because this information is highly temporally unstable
- The user explicitly says to search, browse, verify, or look it up.
</situations_where_you_must_browse_the_internet>

---

## Citations

Results from \`web_run\` include internal reference IDs such as \`turn2search5\`. Use
those reference IDs only in calls to \`web_run\`; do not expose them in the final
response.

Cite sources in the final response using Markdown links:

- Cite a single source as \`[descriptive source title](https://example.com/page)\`.
- Cite multiple sources with separate Markdown links, for example
  \`[first source](https://example.com/one), [second source](https://example.com/two)\`.
- Link directly to the page that supports the claim. Do not link to search result
  pages or use bare URLs.

Formatting of citations:

- Place each citation as near as possible to the claim it supports, normally at
  the end of the sentence or paragraph and after punctuation.
- Do not place citations inside code fences.
- Do not put citations on a line by themselves or collect all citations at the
  end of the response.

If you browse the internet, cite statements supported by web sources. Each cited
source must directly support the associated claim. Prefer primary and
authoritative sources, and use sources from different domains when the response
benefits from multiple perspectives.

---

## Special cases
If these conflict with any other instructions, these should take precedence.

<special_cases>
- When the user asks for information about how to use OpenAI products, (ChatGPT, the OpenAI API, etc.), you should check the code in local env and only browse as fallback, when you browse restrict your sources to official OpenAI websites using the domains filter, unless otherwise requested.
- When using search to answer technical questions, you must only rely on primary sources (research papers, official documentation, etc.)
- Clearly indicate when you are making an inference from sources.
</special_cases>

---

## Word limits
Responses may not excessively quote or draw on a specific source. There are several limits here:
- **Limit on verbatim quotes:**
  - You may not quote more than 25 words verbatim from any single non-lyrical source, unless the source is reddit.
  - For song lyrics, verbatim quotes must be limited to at most 10 words.
  - Long quotes from reddit are allowed, as long as you indicate that those are direct quotes via a markdown blockquote starting with ">", copy verbatim, and link the source.
- **Word limits:**
  - Each webpage source in the sources has a word limit label formatted like "[wordlim N]", in which N is the maximum number of words in the whole response that are attributed to that source. If omitted, the word limit is 200 words.
  - Non-contiguous words derived from a given source must be counted to the word limit.
  - The summarization limit N is a maximum for each source.
  - When using multiple sources, their summarization limits add together. However, each article used must be relevant to the response.
- **Copyright compliance:**
  - You must avoid providing full articles, long verbatim passages, or extensive direct quotes due to copyright concerns.
  - If the user asked for a verbatim quote, the response should provide a short compliant excerpt and then answer with paraphrases and summaries.
  - Again, this limit does not apply to reddit content, as long as it's appropriately indicated that those are direct quotes and you link to the source.
`;

const UINT_SCHEMA = { type: "integer", minimum: 0 } as const;

function searchQueryListSchema(description: string): JsonObject {
	return {
		description,
		type: "array",
		items: {
			type: "object",
			required: ["q"],
			properties: {
				q: { description: "Search query.", type: "string" },
				recency: {
					description: "Whether to filter by recency, as a number of recent days.",
					...UINT_SCHEMA,
				},
				domains: {
					description: "Whether to filter by a specific list of domains.",
					type: "array",
					items: { type: "string" },
				},
			},
		},
	};
}

// codex-api の SearchCommands から schemars が作るスキーマを手で写したもの。
// literature_search_query は対応モデルでしか公開されないため含めない。
const WEB_RUN_PARAMETERS: JsonObject = {
	type: "object",
	properties: {
		search_query: searchQueryListSchema(
			"Query the internet search engine for a given list of queries.",
		),
		image_query: searchQueryListSchema(
			"Query the image search engine for a given list of queries.",
		),
		open: {
			description: "Open pages by reference id or URL.",
			type: "array",
			items: {
				type: "object",
				required: ["ref_id"],
				properties: {
					ref_id: { description: "Reference id or URL to open.", type: "string" },
					lineno: { description: "Line number to position the page at.", ...UINT_SCHEMA },
				},
			},
		},
		click: {
			description: "Open links from previously opened pages.",
			type: "array",
			items: {
				type: "object",
				required: ["id", "ref_id"],
				properties: {
					ref_id: { description: "Reference id containing the numbered link.", type: "string" },
					id: { description: "Numbered link id to open.", ...UINT_SCHEMA },
				},
			},
		},
		find: {
			description: "Find text patterns in pages.",
			type: "array",
			items: {
				type: "object",
				required: ["pattern", "ref_id"],
				properties: {
					ref_id: { description: "Reference id or URL to search within.", type: "string" },
					pattern: { description: "Text pattern to find.", type: "string" },
				},
			},
		},
		screenshot: {
			description: "Take screenshots of PDF pages.",
			type: "array",
			items: {
				type: "object",
				required: ["pageno", "ref_id"],
				properties: {
					ref_id: { description: "Reference id or URL to screenshot.", type: "string" },
					pageno: { description: "Zero-indexed PDF page number.", ...UINT_SCHEMA },
				},
			},
		},
		finance: {
			description: "Look up prices for the given stock symbols.",
			type: "array",
			items: {
				type: "object",
				required: ["ticker", "type"],
				properties: {
					ticker: { description: "Ticker symbol to look up.", type: "string" },
					type: {
						description: "Asset type to look up.",
						type: "string",
						enum: ["equity", "fund", "crypto", "index"],
					},
					market: {
						description: 'ISO 3166-1 alpha-3 country code, "OTC", or "" for cryptocurrency.',
						type: "string",
					},
				},
			},
		},
		weather: {
			description: "Look up weather forecasts.",
			type: "array",
			items: {
				type: "object",
				required: ["location"],
				properties: {
					location: { description: 'Location in "Country, Area, City" format.', type: "string" },
					start: {
						description: "Start date in YYYY-MM-DD format. Defaults to today.",
						type: "string",
					},
					duration: { description: "Number of days to return. Defaults to 7.", ...UINT_SCHEMA },
				},
			},
		},
		sports: {
			description: "Look up sports schedules and standings.",
			type: "array",
			items: {
				type: "object",
				required: ["fn", "league"],
				properties: {
					tool: { description: "Tool name for sports requests.", type: "string", enum: ["sports"] },
					fn: {
						description: "Sports function to call.",
						type: "string",
						enum: ["schedule", "standings"],
					},
					league: {
						description: "League to look up.",
						type: "string",
						enum: ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"],
					},
					team: {
						description:
							"Team to look up, using the common 3 or 4 letter alias used in broadcasts.",
						type: "string",
					},
					opponent: {
						description: "Opponent to use with `team` when narrowing the lookup.",
						type: "string",
					},
					date_from: { description: "Start date in YYYY-MM-DD format.", type: "string" },
					date_to: { description: "End date in YYYY-MM-DD format.", type: "string" },
					num_games: { description: "Number of games to return.", ...UINT_SCHEMA },
					locale: { description: "Locale for the lookup.", type: "string" },
				},
			},
		},
		time: {
			description: "Get time for the given UTC offsets.",
			type: "array",
			items: {
				type: "object",
				required: ["utc_offset"],
				properties: {
					utc_offset: { description: 'UTC offset formatted like "+03:00".', type: "string" },
				},
			},
		},
		response_length: {
			description: "Set the length of the response to be returned.",
			type: "string",
			enum: ["short", "medium", "long"],
		},
	},
};

const uintSchema = z.number().int().nonnegative();
const searchQuerySchema = z.object({
	q: z.string(),
	recency: uintSchema.optional(),
	domains: z.array(z.string()).optional(),
});
// Codex（serde）と同じく未知のキーは無視して落とす。
const searchCommandsSchema = z.object({
	search_query: z.array(searchQuerySchema).optional(),
	literature_search_query: z.array(searchQuerySchema).optional(),
	image_query: z.array(searchQuerySchema).optional(),
	open: z.array(z.object({ ref_id: z.string(), lineno: uintSchema.optional() })).optional(),
	click: z.array(z.object({ ref_id: z.string(), id: uintSchema })).optional(),
	find: z.array(z.object({ ref_id: z.string(), pattern: z.string() })).optional(),
	screenshot: z.array(z.object({ ref_id: z.string(), pageno: uintSchema })).optional(),
	finance: z
		.array(
			z.object({
				ticker: z.string(),
				type: z.enum(["equity", "fund", "crypto", "index"]),
				market: z.string().optional(),
			}),
		)
		.optional(),
	weather: z
		.array(
			z.object({
				location: z.string(),
				start: z.string().optional(),
				duration: uintSchema.optional(),
			}),
		)
		.optional(),
	sports: z
		.array(
			z.object({
				tool: z.enum(["sports"]).optional(),
				fn: z.enum(["schedule", "standings"]),
				league: z.enum(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"]),
				team: z.string().optional(),
				opponent: z.string().optional(),
				date_from: z.string().optional(),
				date_to: z.string().optional(),
				num_games: uintSchema.optional(),
				locale: z.string().optional(),
			}),
		)
		.optional(),
	time: z.array(z.object({ utc_offset: z.string() })).optional(),
	response_length: z.enum(["short", "medium", "long"]).optional(),
});

const searchResponseSchema = z.looseObject({
	encrypted_output: z.string().nullish(),
	output: z.string(),
	results: z.array(z.unknown()).nullish(),
});

type SearchInputMessage =
	| Readonly<{
			type: "message";
			role: "user";
			content: readonly Readonly<{ type: "input_text"; text: string }>[];
	  }>
	| Readonly<{
			type: "message";
			role: "assistant";
			content: readonly Readonly<{ type: "output_text"; text: string }>[];
	  }>;

export type WebRunToolOptions = Readonly<{
	backend: ChatGptBackend;
	sessionId: string;
	model: string;
	// Codex はモデルごとのツール出力の上限（truncation_policy）をそのまま渡している。
	maxOutputTokens: number;
	// 検索の文脈に使う会話履歴。Codex は直近の会話をリクエストの input に入れる。
	conversation: () => readonly Message[];
}>;

export function createWebRunTool(options: WebRunToolOptions): AgentTool {
	return {
		name: "web_run",
		description: WEB_RUN_DESCRIPTION,
		parameters: WEB_RUN_PARAMETERS,
		async execute(argumentsValue, signal) {
			const parsed = searchCommandsSchema.safeParse(argumentsValue);
			if (!parsed.success) return failure(z.prettifyError(parsed.error));
			const commands = parsed.data;
			if (commands.literature_search_query !== undefined) {
				return failure("literature_search_query is unavailable for this model");
			}
			const input = recentSearchInput(options.conversation());
			try {
				const response = await options.backend.request({
					method: "POST",
					path: "codex/alpha/search",
					body: {
						id: options.sessionId,
						model: options.model,
						...(input.length === 0 ? {} : { input }),
						commands,
						settings: {
							allowed_callers: ["direct"],
							// Codex の web_search = "live" に相当する。
							external_web_access: true,
						},
						max_output_tokens: options.maxOutputTokens,
					},
					schema: searchResponseSchema,
					signal,
				});
				return { text: response.output, images: [], isError: false };
			} catch (error) {
				signal.throwIfAborted();
				return failure(error instanceof Error ? error.message : String(error));
			}
		},
	};
}

function failure(message: string): AgentToolResult {
	return { text: truncateUtf8(message, MAX_SEARCH_ERROR_BYTES), images: [], isError: true };
}

function truncateUtf8(message: string, maxBytes: number): string {
	const suffix = "… [truncated]";
	if (Buffer.byteLength(message) <= maxBytes) return message;
	const budget = maxBytes - Buffer.byteLength(suffix);
	return `${sliceUtf8(message, budget)}${suffix}`;
}

// Codex の recent_input と同じく、直前のユーザー発言・その後のアシスタントの文章（合計1kトークンまで）・
// 現在のユーザー発言だけを残す。画像やツール呼び出しは含めない。
function recentSearchInput(messages: readonly Message[]): SearchInputMessage[] {
	const visible: SearchInputMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const texts =
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
			if (texts.length > 0) {
				visible.push({
					type: "message",
					role: "user",
					content: texts.map((text) => ({ type: "input_text", text })),
				});
			}
		} else if (message.role === "assistant") {
			const texts = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
			if (texts.length > 0) {
				visible.push({
					type: "message",
					role: "assistant",
					content: texts.map((text) => ({ type: "output_text", text })),
				});
			}
		}
	}
	return truncateAssistantText(retainTailFromLastUserMessages(visible, 2));
}

function retainTailFromLastUserMessages(
	messages: readonly SearchInputMessage[],
	userMessageCount: number,
): SearchInputMessage[] {
	const userIndexes = messages.flatMap((message, index) =>
		message.role === "user" ? [index] : [],
	);
	const latest = userIndexes.at(-1);
	if (latest === undefined) return [];
	const earliest = userIndexes.at(-userMessageCount) ?? userIndexes[0] ?? latest;
	return messages.slice(earliest, latest + 1);
}

function truncateAssistantText(messages: readonly SearchInputMessage[]): SearchInputMessage[] {
	let remaining = ASSISTANT_CONTEXT_TOKEN_LIMIT;
	return messages.flatMap((message): SearchInputMessage[] => {
		if (message.role === "user") return [message];
		const content: { type: "output_text"; text: string }[] = [];
		for (const part of message.content) {
			if (remaining === 0) break;
			const tokens = approxTokenCount(part.text);
			if (tokens <= remaining) {
				remaining -= tokens;
				content.push(part);
			} else {
				content.push({ type: "output_text", text: truncateMiddle(part.text, remaining) });
				remaining = 0;
			}
		}
		return content.length === 0 ? [] : [{ ...message, content }];
	});
}

function approxTokenCount(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / APPROX_BYTES_PER_TOKEN);
}

// codex-rs/utils/string の plan_token_truncation と同じく、先頭と末尾を残して中央を省く。
function truncateMiddle(text: string, maxTokens: number): string {
	const maxBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
	const totalBytes = Buffer.byteLength(text);
	if (totalBytes <= maxBytes) return text;
	const left = Math.floor(maxBytes / 2);
	const right = maxBytes - left;
	const removedTokens = Math.ceil((totalBytes - maxBytes) / APPROX_BYTES_PER_TOKEN);
	return `${sliceUtf8(text, left)}…${removedTokens} tokens truncated…${sliceUtf8FromEnd(text, right)}`;
}

// UTF-8 のバイト数で先頭・末尾を切り出す。Codex の floor/ceil_char_boundary と同じく文字の途中では切らない。
function sliceUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	let end = Math.min(maxBytes, bytes.length);
	while (end > 0 && isContinuationByte(bytes[end])) end -= 1;
	return bytes.subarray(0, end).toString("utf8");
}

function sliceUtf8FromEnd(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	let start = Math.max(0, bytes.length - maxBytes);
	while (start < bytes.length && isContinuationByte(bytes[start])) start += 1;
	return bytes.subarray(start).toString("utf8");
}

function isContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}
