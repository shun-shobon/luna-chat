import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";

export type HonoServerHandle = Readonly<{
	port: number;
	close(): Promise<void>;
}>;

export async function listenHono(
	app: Hono,
	input: Readonly<{ hostname: string; port: number; onError(error: Error): void }>,
): Promise<HonoServerHandle> {
	const server = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
		let started = false;
		const running = serve(
			{ fetch: app.fetch, hostname: input.hostname, port: input.port },
			(info) => {
				started = true;
				resolve({ server: running, port: info.port });
			},
		);
		running.on("error", (error: Error) => {
			if (started) input.onError(error);
			else reject(error);
		});
	});

	return {
		port: server.port,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		},
	};
}
