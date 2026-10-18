export type AutomationCheckResult =
	| Readonly<{ status: "succeeded"; stdout: string }>
	| Readonly<{
			error?: unknown;
			exitCode: number | null;
			signal: string | null;
			status: "failed";
			stderr: string;
			timedOut: boolean;
	  }>;

export interface AutomationCheckRunnerPort {
	run(command: string): Promise<AutomationCheckResult>;
}
