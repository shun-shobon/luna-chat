import type { JsonObject, JsonValue } from "../../../shared/json";
import type { HomeAssistantState } from "../domain/state-change";

export type HomeAssistantServiceCall = Readonly<{
	domain: string;
	service: string;
	data: JsonObject;
	returnResponse: boolean;
}>;

export type HomeAssistantServiceResult = Readonly<{
	changedStates: readonly HomeAssistantState[];
	serviceResponse: JsonValue | undefined;
}>;

export type HomeAssistantServiceDomain = Readonly<{
	domain: string;
	services: Readonly<
		Record<
			string,
			Readonly<{ description?: string; fields: Readonly<Record<string, string | null>> }>
		>
	>;
}>;

export interface HomeAssistantRestPort {
	listStates(signal: AbortSignal): Promise<readonly HomeAssistantState[]>;
	getState(entityId: string, signal: AbortSignal): Promise<HomeAssistantState | undefined>;
	listServices(signal: AbortSignal): Promise<readonly HomeAssistantServiceDomain[]>;
	callService(
		call: HomeAssistantServiceCall,
		signal: AbortSignal,
	): Promise<HomeAssistantServiceResult>;
}

export type HomeAssistantRegistryEntry = Readonly<{
	areaName: string | null;
	areaId: string | null;
	deviceName: string | null;
}>;

export interface HomeAssistantRegistryPort {
	// エンティティIDごとのエリアとデバイス。登録情報にないエンティティは含めない。
	entityPlacements(): Promise<ReadonlyMap<string, HomeAssistantRegistryEntry>>;
}
