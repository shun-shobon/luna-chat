import { Hono } from "hono";

import { listenHono } from "../../../shared/hono-server";
import type { HonoServerHandle } from "../../../shared/hono-server";
import type { DashboardService } from "../application/dashboard-service";
import { DASHBOARD_PAGE_HTML } from "./dashboard-page";

const NO_STORE = { "cache-control": "no-store" };

export async function startDashboardServer(
	input: Readonly<{
		dashboard: Pick<DashboardService, "snapshot">;
		hostname: string;
		port: number;
		onError(error: Error): void;
	}>,
): Promise<HonoServerHandle> {
	const app = new Hono();
	app.onError((error, context) => {
		input.onError(error);
		return context.json({ error: "internal_error" }, 500);
	});
	app.get("/", (context) => context.html(DASHBOARD_PAGE_HTML, 200, NO_STORE));
	app.get("/api/snapshot", (context) => context.json(input.dashboard.snapshot(), 200, NO_STORE));
	return await listenHono(app, input);
}
