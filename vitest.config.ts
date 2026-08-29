import { defineConfig } from "vitest/config";

export default defineConfig({
  /**
   * `tsconfig.json` sets `jsx: "preserve"` because Next compiles JSX with SWC and
   * tsc only type-checks. The test runner has no SWC, so it needs telling —
   * without this every `.test.tsx` fails to parse rather than to assert.
   */
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // No test may touch the network: every AWS/Telegram/Bedrock boundary is an
    // interface with an in-memory fake (ralph-loop-prompt.md, Engineering Bar).
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "cdk.out/**", ".next/**"],
  },
});
