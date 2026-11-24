import type {
	ActivityListener,
	ActivityNotice,
	SessionActivities,
} from "../../agent/ports/outbound/agent-session-port";
import type { ActivityHandle, ToolActivities } from "../domain/tool";

export type ActivityTable = SessionActivities & ToolActivities;

// ツールはセッションより先に作られるため、セッションごとの作業はこの表で持ち、開いたセッションへ後からつなぐ。
export function createActivityTable(): ActivityTable {
	const active = new Map<number, () => Promise<void>>();
	let nextId = 0;
	let listener: ActivityListener | undefined;
	let buffered: ActivityNotice[] = [];

	const deliver = (notice: ActivityNotice): void => {
		if (listener === undefined) {
			buffered.push(notice);
			return;
		}
		listener.notify(notice);
	};

	return {
		count: () => active.size,
		stopAll: async () => {
			const stops = [...active.values()];
			active.clear();
			const settled = await Promise.allSettled(stops.map(async (stop) => await stop()));
			listener?.stopped();
			const failures: unknown[] = [];
			for (const result of settled) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, "Failed to stop session activities");
			}
		},
		connect: (next) => {
			if (listener !== undefined) throw new Error("Session activities are already connected");
			listener = next;
			const pending = buffered;
			buffered = [];
			for (const notice of pending) next.notify(notice);
		},
		begin: (stop): ActivityHandle => {
			const id = nextId;
			nextId += 1;
			active.set(id, stop);
			return {
				notify: (message, options) => {
					if (!active.has(id)) return;
					deliver({ message, urgent: options.urgent, replaceKey: options.replaceKey });
				},
				end: () => {
					if (!active.delete(id)) return;
					listener?.stopped();
				},
			};
		},
	};
}
