import { loginWithDeviceCode } from "../modules/agent/adapters/outbound/pi/login";
import { resolveLunaHome } from "../modules/workspace/adapters/initialize-workspace";
import { createAgentModels, credentialsPath } from "./agent-runtime";

export async function runLogin(signal: AbortSignal): Promise<void> {
	const lunaHomeDir = resolveLunaHome(process.env["LUNA_HOME"]);
	await loginWithDeviceCode(createAgentModels(lunaHomeDir), signal);
	process.stdout.write(`Saved ChatGPT credentials to ${credentialsPath(lunaHomeDir)}\n`);
}
