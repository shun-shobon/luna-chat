export interface TranscriptPrunerPort {
	prune(now: Date, retentionMs: number): Promise<void>;
}
