export interface RetentionPrunerPort {
	prune(now: Date, retentionMs: number): Promise<void>;
}
