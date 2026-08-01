import { externals } from "nf3/plugin";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  minify: true,
  plugins: [
    externals({
      traceInclude: ["@openai/codex/bin/codex.js"],
    }),
  ],
  sourcemap: true,
});
