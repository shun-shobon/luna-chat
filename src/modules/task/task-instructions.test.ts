import { expect, it } from "vitest";

import { TASK_BOARD_INSTRUCTIONS, TASK_WORKER_INSTRUCTIONS } from "./task-instructions";

it("依頼元と作業エージェントの固定指示を保つ", () => {
	expect({ TASK_BOARD_INSTRUCTIONS, TASK_WORKER_INSTRUCTIONS }).toMatchSnapshot();
});
