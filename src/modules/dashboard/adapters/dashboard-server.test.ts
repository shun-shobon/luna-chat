import { afterEach, describe, expect, it, vi } from "vitest";

import type { HonoServerHandle } from "../../../shared/hono-server";
import type { DashboardSnapshot } from "../application/dashboard-service";
import { startDashboardServer } from "./dashboard-server";

const servers: HonoServerHandle[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

describe("dashboard server", () => {
	it("ページをキャッシュさせずに返す", async () => {
		const { url } = await start(() => snapshot);

		const response = await fetch(url);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain("api/snapshot");
	});

	it("取得のたびに最新のスナップショットをJSONで返す", async () => {
		let generatedAt = "2026-10-20T00:00:00.000Z";
		const { url } = await start(() => ({ ...snapshot, generatedAt }));

		const first = await fetch(`${url}/api/snapshot`);
		generatedAt = "2026-10-20T00:00:03.000Z";
		const second = await fetch(`${url}/api/snapshot`);

		expect(first.headers.get("cache-control")).toBe("no-store");
		expect(await first.json()).toEqual(snapshot);
		expect(await second.json()).toEqual({ ...snapshot, generatedAt });
	});

	it("スナップショット取得の例外は500にして記録し、未知のパスは404にする", async () => {
		const failure = new Error("snapshot failed");
		const { onError, url } = await start(() => {
			throw failure;
		});

		const failed = await fetch(`${url}/api/snapshot`);
		const missing = await fetch(`${url}/events`);

		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: "internal_error" });
		expect(onError).toHaveBeenCalledWith(failure);
		expect(missing.status).toBe(404);
	});
});

const snapshot: DashboardSnapshot = {
	activity: [],
	agent: { lastFailure: null, restartLimit: 5, restartsInWindow: 0, state: "ready" },
	automation: {
		heartbeat: { enabled: true, nextFireAt: "2026-10-20T00:10:00.000Z" },
		memoryMaintenance: { cron: "0 4 * * *", enabled: true, nextFireAt: null },
		schedule: [],
	},
	conversations: [],
	events: [],
	generatedAt: "2026-10-20T00:00:00.000Z",
	startedAt: "2026-10-19T23:00:00.000Z",
	tasks: { maxConcurrent: 2, running: 0, tasks: [] },
};

async function start(read: () => DashboardSnapshot) {
	const onError = vi.fn();
	const server = await startDashboardServer({
		dashboard: { snapshot: read },
		hostname: "127.0.0.1",
		port: 0,
		onError,
	});
	servers.push(server);
	return { onError, url: `http://127.0.0.1:${String(server.port)}` };
}
