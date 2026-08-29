import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No test may touch the network: every AWS/Telegram/Bedrock boundary is an
    // interface with an in-memory fake (ralph-loop-prompt.md, Engineering Bar).
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "cdk.out/**", ".next/**"],
  },
});
