import { describe, expect, it } from "vitest";

import {
	ASSIST_INSTRUCTIONS,
	HOME_ASSISTANT_TOOL_INSTRUCTIONS,
	HOME_ASSISTANT_WATCH_INSTRUCTIONS,
} from "./home-assistant-instructions";

describe("Home Assistantの開発者指示", () => {
	it("固定の指示を保持する", () => {
		expect({
			ASSIST_INSTRUCTIONS,
			HOME_ASSISTANT_TOOL_INSTRUCTIONS,
			HOME_ASSISTANT_WATCH_INSTRUCTIONS,
		}).toMatchSnapshot();
	});
});
