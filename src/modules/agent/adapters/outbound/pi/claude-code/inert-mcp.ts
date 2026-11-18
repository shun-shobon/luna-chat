// tsdown が1ファイルにまとめるため、別ファイルの .mjs は配布物から辿れない。ワーカーの一時ディレクトリへ書き出して起動する。
// Claude Code にツールの一覧だけを見せ、呼び出しは必ず拒む。ツールを実行するのは luna 側だけ。
export const INERT_MCP_SCRIPT = String.raw`import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const manifestPath = process.argv[2];
if (!manifestPath) process.exit(2);
const tools = JSON.parse(await readFile(manifestPath, "utf8"));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }

  let result = {};
  if (request.method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-inert-tool-inventory", version: "1" },
    };
  } else if (request.method === "tools/list") {
    result = { tools };
  } else if (request.method === "tools/call") {
    result = {
      isError: true,
      content: [{ type: "text", text: "Denied: Claude Code tools are inert; only luna executes tools." }],
    };
  }

  if (request.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  }
}
`;
