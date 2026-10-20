import { describe, expect, it } from "vitest";

import { readRuntimeEnvironment } from "./runtime-environment";

describe("readRuntimeEnvironment", () => {
	it("必須tokenと明示値を検証する", () => {
		expect(
			readRuntimeEnvironment({
				DISCORD_BOT_TOKEN: "token",
				LOG_LEVEL: "debug",
				LUNA_DASHBOARD_HOST: "0.0.0.0",
				LUNA_DASHBOARD_PORT: "8080",
				LUNA_HOME: "/var/lib/luna",
				UNRELATED: "preserved outside this parser",
			}),
		).toEqual({
			dashboardHost: "0.0.0.0",
			dashboardPort: 8080,
			discordBotToken: "token",
			httpHost: "127.0.0.1",
			httpPort: 3000,
			logLevel: "debug",
			lunaHome: "/var/lib/luna",
		});
	});

	it("省略可能な環境変数に明示既定値を適用する", () => {
		expect(readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token" })).toEqual({
			dashboardHost: "127.0.0.1",
			dashboardPort: 3001,
			discordBotToken: "token",
			httpHost: "127.0.0.1",
			httpPort: 3000,
			logLevel: "info",
		});
	});

	it("空白tokenと不正levelを拒否する", () => {
		expect(() => readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "  " })).toThrow(
			"at DISCORD_BOT_TOKEN",
		);
		expect(() =>
			readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token", LOG_LEVEL: "verbose" }),
		).toThrow("at LOG_LEVEL");
		expect(() =>
			readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token", LUNA_HTTP_PORT: "0" }),
		).toThrow("at LUNA_HTTP_PORT");
		expect(() =>
			readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token", LUNA_HTTP_HOST: "example.com" }),
		).toThrow("at LUNA_HTTP_HOST");
		expect(() =>
			readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token", LUNA_DASHBOARD_PORT: "65536" }),
		).toThrow("at LUNA_DASHBOARD_PORT");
		expect(() =>
			readRuntimeEnvironment({ DISCORD_BOT_TOKEN: "token", LUNA_DASHBOARD_HOST: "localhost" }),
		).toThrow("at LUNA_DASHBOARD_HOST");
	});
});
