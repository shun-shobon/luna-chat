const DEFAULT_TYPING_INTERVAL_MS = 8_000;

export type TypingLifecycleRegistry = {
  start: (input: StartTypingLifecycleInput) => {
    alreadyRunning: boolean;
    ok: true;
    stop: () => void;
  };
  stopByChannelId: (channelId: string) => void;
  stopAll: () => void;
};

export type StartTypingLifecycleInput = {
  channelId: string;
  source?: string | undefined;
  sendTyping?: (() => Promise<unknown>) | undefined;
  onTypingError?: ((error: unknown) => void) | undefined;
};

type CreateTypingLifecycleRegistryInput = {
  intervalMs?: number | undefined;
  setIntervalFn?: typeof setInterval | undefined;
  clearIntervalFn?: typeof clearInterval | undefined;
};

export function createTypingLifecycleRegistry(
  input?: CreateTypingLifecycleRegistryInput,
): TypingLifecycleRegistry {
  const activeIntervals = new Map<
    string,
    { channelId: string; interval: ReturnType<typeof setInterval> }
  >();
  const intervalMs = input?.intervalMs ?? DEFAULT_TYPING_INTERVAL_MS;

  const stopByLifecycleKey = (lifecycleKey: string): void => {
    const activeEntry = activeIntervals.get(lifecycleKey);
    if (!activeEntry) {
      return;
    }
    const clearIntervalFn = input?.clearIntervalFn ?? clearInterval;
    clearIntervalFn(activeEntry.interval);
    activeIntervals.delete(lifecycleKey);
  };

  const stopByChannelId = (channelId: string): void => {
    for (const [lifecycleKey, activeEntry] of activeIntervals.entries()) {
      if (activeEntry.channelId !== channelId) {
        continue;
      }
      stopByLifecycleKey(lifecycleKey);
    }
  };

  return {
    start: (startInput) => {
      const lifecycleKey = `${startInput.channelId}::${startInput.source ?? "default"}`;
      const sendTyping = startInput.sendTyping;
      if (!sendTyping) {
        return {
          alreadyRunning: false,
          ok: true,
          stop: () => undefined,
        };
      }

      if (activeIntervals.has(lifecycleKey)) {
        return {
          alreadyRunning: true,
          ok: true,
          stop: () => {
            stopByLifecycleKey(lifecycleKey);
          },
        };
      }

      const runSendTyping = (): void => {
        void sendTyping().catch((error: unknown) => {
          startInput.onTypingError?.(error);
        });
      };

      runSendTyping();
      const setIntervalFn = input?.setIntervalFn ?? setInterval;
      const interval = setIntervalFn(runSendTyping, intervalMs);
      activeIntervals.set(lifecycleKey, {
        channelId: startInput.channelId,
        interval,
      });

      return {
        alreadyRunning: false,
        ok: true,
        stop: () => {
          stopByLifecycleKey(lifecycleKey);
        },
      };
    },
    stopAll: () => {
      for (const lifecycleKey of activeIntervals.keys()) {
        stopByLifecycleKey(lifecycleKey);
      }
    },
    stopByChannelId,
  };
}
