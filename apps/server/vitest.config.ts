import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
