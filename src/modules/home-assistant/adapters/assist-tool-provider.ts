import { z } from "zod";

import { defineTool } from "../../tool/ports/tool-provider";
import type { ToolProvider } from "../../tool/ports/tool-provider";

const respondInputSchema = z.strictObject({
	request_id: z.uuid(),
	speech: z.string().trim().min(1).max(2_000),
	continue_conversation: z.boolean().optional(),
});

export function createAssistToolProvider(
	responses: Readonly<{
		respond(requestId: string, speech: string, continueConversation: boolean): void;
	}>,
): ToolProvider {
	return Object.freeze({
		definitions: Object.freeze([
			defineTool({
				name: "assist_respond",
				description:
					"Answer an assist_request: speech is read aloud by the Home Assistant voice assistant right away, and your run continues afterwards. request_id is the event id. Set continue_conversation to true when you asked something and expect a spoken answer immediately. Each request accepts one response.",
				inputSchema: respondInputSchema,
				parseInput: (input) => ({
					requestId: input.request_id,
					speech: input.speech.trim(),
					continueConversation: input.continue_conversation ?? false,
				}),
				execute: (input) => {
					responses.respond(input.requestId, input.speech, input.continueConversation);
					return Promise.resolve({ request_id: input.requestId });
				},
				describeTarget: (input) => ({ request_id: input.requestId }),
			}),
		]),
		release: async () => {},
	});
}
