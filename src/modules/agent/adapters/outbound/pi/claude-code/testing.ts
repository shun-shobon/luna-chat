import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export type FakeClaude = Readonly<{
	root: string;
	// claude を PATH から探すため、偽物のディレクトリを先頭に置いた PATH を渡す。
	env: { PATH: string };
	cleanup(): Promise<void>;
}>;

export async function createFakeClaude(body: string): Promise<FakeClaude> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "luna-claude-code-test-")));
	const executable = join(root, "claude");
	await writeFile(executable, `#!/usr/bin/env node\n${body}`, "utf8");
	await chmod(executable, 0o755);
	return {
		root,
		env: { PATH: `${root}${delimiter}${process.env["PATH"] ?? ""}` },
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

export const AUTH_STATUS_OK = `if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "max"}));
  process.exit(0);
}
`;
