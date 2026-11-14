import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Context, Hono } from "hono";

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

export type JsonRequestBody =
	| Readonly<{ kind: "parsed"; body: unknown }>
	| Readonly<{ kind: "rejected"; response: Response }>;

export async function readJsonRequestBody(context: Context): Promise<JsonRequestBody> {
	if (
		context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
		"application/json"
	) {
		return {
			kind: "rejected",
			response: context.json({ error: "content_type_must_be_json" }, 415),
		};
	}
	try {
		return { kind: "parsed", body: await context.req.json() };
	} catch {
		return { kind: "rejected", response: context.json({ error: "invalid_json" }, 400) };
	}
}
