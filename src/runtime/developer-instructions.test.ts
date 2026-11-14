import { describe, expect, it } from "vitest";

import {
	EVENT_INSTRUCTIONS,
	LUNA_CONVERSATION_GUIDE,
	LUNA_CORE_INSTRUCTIONS,
	SESSION_END_INSTRUCTIONS,
} from "./developer-instructions";

describe("開発者指示", () => {
	it("固定の指示を保持する", () => {
		expect({
			LUNA_CORE_INSTRUCTIONS,
			LUNA_CONVERSATION_GUIDE,
			SESSION_END_INSTRUCTIONS,
			EVENT_INSTRUCTIONS,
		}).toMatchSnapshot();
	});
});
