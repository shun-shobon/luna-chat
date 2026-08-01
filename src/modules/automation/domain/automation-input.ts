export type AutomationInput =
  | {
      checklist: string;
      source: "heartbeat";
    }
  | {
      jobId: string;
      prompt: string;
      source: "schedule";
    }
  | {
      date: string;
      source: "memory_maintenance";
    };
