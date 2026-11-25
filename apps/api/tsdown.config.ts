import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/main.ts",
    "src/worker.ts",
    "src/migrate.ts",
    "src/seed-demo.ts",
    "src/instrumentation.ts",
  ],
  platform: "node",
  format: "esm",
  target: "node24",
  // Workspace packages ship TypeScript source, so bundle them; npm dependencies stay external.
  noExternal: [/^@gym\//],
  sourcemap: true,
  clean: true,
});
