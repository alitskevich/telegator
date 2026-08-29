import { afterAll, describe, expect, test, vi } from "vitest";
import { isolatedOutdir, removeIsolatedOutdirs } from "../../test/support/cdkOutdir.js";
/**
 * A private CDK output directory per App.
 *
 * `NodejsFunction` stages its bundle on disk during synth, so parallel vitest
 * workers sharing one cdk.out race over the staging directory.
 */
import { createApp } from "./app.js";

// Item 10.0 — without this each synth leaves ~9 MB of bundles behind.
afterAll(removeIsolatedOutdirs);

// The app now contains the pipeline stack, whose synth bundles five Lambdas.
vi.setConfig({ testTimeout: 60_000 });

describe("the CDK app", () => {
  test("synthesizes without AWS credentials", () => {
    expect(() => createApp({ outdir: isolatedOutdir() }).synth()).not.toThrow();
  });

  test("declares at least one stack, or `cdk synth` exits 1", () => {
    // Empirically: an App with no stacks fails with "This app contains no stacks".
    expect(createApp({ outdir: isolatedOutdir() }).synth().stacks.length).toBeGreaterThan(0);
  });

  /**
   * The load-bearing one. `cdk synth` only works without credentials while every
   * stack stays environment-agnostic. A hardcoded account/region — or any context
   * lookup, which forces one — turns synth into an authenticated call and breaks
   * the only infrastructure gate this machine has.
   */
  test("every stack is environment-agnostic", () => {
    for (const stack of createApp({ outdir: isolatedOutdir() }).synth().stacks) {
      expect(stack.environment.account).toBe("unknown-account");
      expect(stack.environment.region).toBe("unknown-region");
    }
  });

  test("no stack asks for a context lookup", () => {
    const assembly = createApp({ outdir: isolatedOutdir() }).synth();

    for (const stack of assembly.stacks) {
      // CDK records unresolved lookups as `missing` context entries and returns
      // dummy values, so synth "succeeds" while the template is a placeholder.
      expect(assembly.manifest.missing ?? []).toEqual([]);
      expect(stack.template).toBeDefined();
    }
  });
});
