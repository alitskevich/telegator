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
 * Synth in a test builds a CloudFormation template to assert on; it does not
 * need the Lambda code inside it. `NodejsFunction` does not know that, and runs
 * esbuild for all five functions on every synth — five bundles plus source maps,
 * roughly 9 MB, once per context variant per file (`cdkOutdir` describes what
 * that costs on disk). It cost more in time: 87 of the suite's 112 seconds of
 * work. Vitest parallelises across files but never within one, so
 * `app-stack.test.ts` alone — 36 synths — held the whole run at 23s of a 25s
 * wall clock. No arrangement of test scopes can split a single file.
 *
 * `aws:cdk:bundling-stacks: []` matches no stack, so every asset stages a stub
 * and no esbuild runs. The template shape is unchanged, which is all these tests
 * read; the suite went to 12s with all 1757 tests still passing. Real bundling
 * is still exercised on every gate run by `cdk synth`, where a bundle that
 * cannot build is a synth failure rather than a test one — which is where it
 * belongs, since a deploy fails there too.
 *
 * It leads the spread, so a test that does need a real bundle overrides it.
 */
const NO_BUNDLING = { "aws:cdk:bundling-stacks": [] };

/**
 * cdk.json's context, with `overrides` applied on top.
 *
 * Overrides last, so a test can still set `env`, `scheduleEnabled` or any other
 * deploy-time parameter without discarding the flags underneath it.
 */
export function cdkContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...NO_BUNDLING, ...FLAGS, ...overrides };
}
