import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";

import { createAgentModels } from "./agent-runtime";

describe("createAgentModels", () => {
	it("pi-ai のカタログにない gpt-6.2-sol を 6.1 Sol と同じ定義で足す", () => {
		const models = createAgentModels("/nonexistent/luna-home");
		const gpt61Sol = models.getModel("openai-codex", "gpt-6.1-sol");
		const gpt62Sol = models.getModel("openai-codex", "gpt-6.2-sol");

		expect(gpt61Sol).toBeDefined();
		expect(gpt62Sol).toEqual({ ...gpt61Sol, id: "gpt-6.2-sol", name: "GPT-6.2 Sol" });
		expect(gpt62Sol?.contextWindow).toBe(500_000);
		if (gpt62Sol === undefined) return;
		expect(getSupportedThinkingLevels(gpt62Sol)).not.toContain("off");
		expect(
			models.getModels("openai-codex").filter((model) => model.id === "gpt-6.2-sol"),
		).toHaveLength(1);
	});
});
