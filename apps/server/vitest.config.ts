import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the TypeScript sources; compiled copies under dist/ are never
    // runnable (their data files are not emitted).
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
