import { defineConfig } from "tsdown";

export default defineConfig({
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  entry: ["./src/index.ts"],
  format: "cjs",
  minify: true,
  outDir: "dist/sea",
});
