import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Opt-in live E2E steps for the Director Suite (never part of `npm test`: the normal config only
 * includes *.test / *.spec files). Driven by the #[ignore]d Rust harness in
 * src-tauri/src/commands/media_e2e.rs, which sets E2E_LIVE=1, E2E_STEP and E2E_DIR.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../../../..", import.meta.url)),
  resolve: {
    alias: { "@": fileURLToPath(new URL("../../..", import.meta.url)) },
  },
  test: {
    include: ["src/features/director/e2e/*.e2e.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
