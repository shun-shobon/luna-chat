import { resolve } from "node:path";

import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

// Agent Skills の SKILL.md を探し、システムプロンプトへ載せる一覧（名前・説明・パス）にする。
export function readWorkspaceSkillsPrompt(workspaceDir: string): string {
	const { skills } = loadSkillsFromDir({
		dir: resolve(workspaceDir, ".agents", "skills"),
		source: "workspace",
	});
	return formatSkillsForPrompt(skills, "read");
}
