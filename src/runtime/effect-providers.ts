import {
	createDiscordDelegationEffectProvider,
	createDiscordEffectProvider,
} from "../modules/discord/adapters/discord-effect-provider";
import type { DiscordActionPort } from "../modules/discord/ports/discord-action-port";
import type { DiscordConversationDelegationPort } from "../modules/discord/ports/discord-conversation-delegation-port";
import { createWaitEffectProvider } from "../modules/effect/adapters/wait-effect-provider";
import type { EffectProvider } from "../modules/effect/ports/effect-provider";
import { createHttpResponseEffectProvider } from "../modules/http/adapters/http-response-effect-provider";
import type { HttpResponseRegistry } from "../modules/http/application/http-response-registry";

export function createEffectProviders(
	dependencies: Readonly<{
		actions: DiscordActionPort;
		delegation: DiscordConversationDelegationPort;
		httpResponses: HttpResponseRegistry;
	}>,
): readonly EffectProvider[] {
	return [
		createDiscordEffectProvider(dependencies.actions),
		createDiscordDelegationEffectProvider(dependencies.delegation),
		createWaitEffectProvider(),
		createHttpResponseEffectProvider(dependencies.httpResponses),
	];
}
