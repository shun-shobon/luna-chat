import type { WatchConfigState } from "../domain/home-assistant-status";

export interface WatchConfigPort {
	read(): WatchConfigState;
}
