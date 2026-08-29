import { readFileSync } from "node:fs";

/**
 * cdk.json's context — the feature flags `cdk synth` and every deploy load.
 *
 * A CDK `App` constructed directly does not read cdk.json: the CLI passes that
 * context in, so `new App({ context: {} })` starts with none of it. Feature
 * flags are not cosmetic, and an unset one falls back to the pre-flag default,
 * so a suite built on an empty context asserts against a template no deploy will
 * ever produce.
 *
 * That gap is not hypothetical. With the flags absent the pipeline stack
 * synthesised one log group; with them it synthesises six, and two of those
 * collided on `/aws/lambda/telegator-dev-analyze` — the failure R41 exists to
 * fix. Every gate stayed green while the deploy could not create the stack.
 *
 * Read once: cdk.json does not change within a run, and each test file builds
 * several apps.
 */
const FLAGS = JSON.parse(readFileSync(new URL("../../cdk.json", import.meta.url), "utf8"))
  .context as Record<string, unknown>;

/**
 * cdk.json's context, with `overrides` applied on top.
 *
 * Overrides last, so a test can still set `env`, `scheduleEnabled` or any other
 * deploy-time parameter without discarding the flags underneath it.
 */
export function cdkContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FLAGS, ...overrides };
}
