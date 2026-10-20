import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No test touches the network. Firestore is the emulator `npm test` starts,
    // shared by every file, so files run one at a time.
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/www/dist/**"],
    fileParallelism: false,
  },
});
