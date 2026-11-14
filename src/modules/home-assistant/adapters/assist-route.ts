import type { Hono } from "hono";

import { readJsonRequestBody } from "../../../shared/hono-server";
import type { AssistService } from "../application/assist-service";
import { assistRequestSchema } from "../domain/assist-request";

export const ASSIST_ROUTE_PATH = "/home-assistant/conversation";

export function registerAssistRoute(app: Hono, service: AssistService): void {
	app.post(ASSIST_ROUTE_PATH, async (context) => {
		const body = await readJsonRequestBody(context);
		if (body.kind === "rejected") return body.response;
		const parsed = assistRequestSchema.safeParse(body.body);
		if (!parsed.success) return context.json({ error: "invalid_request" }, 400);

		const result = await service.submit(parsed.data);
		switch (result.kind) {
			case "unavailable":
				return context.json({ error: "unavailable" }, 503);
			case "failed":
				return context.json({ error: "execution_failed" }, 500);
			case "response":
				return context.json(
					{ speech: result.speech, continue_conversation: result.continueConversation },
					200,
				);
			default:
				throw new Error(`Unknown assist result: ${JSON.stringify(result satisfies never)}`);
		}
	});
}
