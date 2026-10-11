export function createCodexChildEnvironment(
	parentEnvironment: NodeJS.ProcessEnv,
	codexHomeDir: string,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parentEnvironment)) {
		if (typeof value === "string" && key !== "DISCORD_BOT_TOKEN") {
			environment[key] = value;
		}
	}
	environment["CODEX_HOME"] = codexHomeDir;
	return environment;
}
