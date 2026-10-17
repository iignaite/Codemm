import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 900_000,
    // Docker tests count the containers Codemm owns, so files must not overlap.
    fileParallelism: false,
  },
});
