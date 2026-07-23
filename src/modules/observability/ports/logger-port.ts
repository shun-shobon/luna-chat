export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogContext = Readonly<{
  actionIndex?: number | undefined;
  conversationScope?: string | undefined;
  jobId?: string | undefined;
  requestId?: string | number | undefined;
  threadId?: string | undefined;
  toolCallId?: string | undefined;
  turnId?: string | undefined;
  typingLeaseId?: string | undefined;
}>;

export interface LoggerPort {
  log(
    level: LogLevel,
    event: string,
    context?: LogContext,
    details?: Readonly<Record<string, unknown>>,
    payload?: unknown,
  ): void;
}
