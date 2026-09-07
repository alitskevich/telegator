import { App } from "aws-cdk-lib";
import { describe, expect, test, vi } from "vitest";
import { SETTLE_DELAY_SECONDS, SQS_MAX_DELAY_SECONDS } from "../../lib/dedup/constants";
import { cdkContext } from "../../test/support/cdkContext";
import { ENVIRONMENTS, resolveConfig } from "./config";
import { resourceName } from "./naming";

/**
 * The 5 s default is not enough for the first synth in a worker: CDK stages
 * bundles on disk, and under the suite's parallelism these files intermittently
 * timed out while the assertions themselves are instant. The synth-based test
 * files that already raise it were, until now, only most of them.
 */
vi.setConfig({ testTimeout: 60_000 });

describe("resourceName", () => {
  /** §9.2 L896 requires environment-prefixed names but never gives the form. */
  test("applies the telegator-{env}-{resource} scheme", () => {
    expect(resourceName("dev", "messages")).toBe("telegator-dev-messages");
    expect(resourceName("prod", "analyze")).toBe("telegator-prod-analyze");
  });

  test("is stable, so a rename is a deliberate diff and not a drift", () => {
    expect(resourceName("dev", "sources")).toBe(resourceName("dev", "sources"));
  });

  /** A FIFO queue's name must end in `.fifo`; §7.3 L647-648's names omit it. */
  test("appends the .fifo suffix when asked", () => {
    expect(resourceName("dev", "aggregate", { fifo: true })).toBe("telegator-dev-aggregate.fifo");
  });

  test("keeps the .fifo suffix last, after the environment prefix", () => {
    expect(resourceName("prod", "publish", { fifo: true }).endsWith(".fifo")).toBe(true);
  });
});

describe("resolveConfig", () => {
  const appWith = (context: Record<string, unknown>) => new App({ context: cdkContext(context) });

  test("reads the environment from context", () => {
    expect(resolveConfig(appWith({ env: "prod" })).env).toBe("prod");
  });

  test("defaults to dev, the environment that cannot post to production channels", () => {
    expect(resolveConfig(appWith({})).env).toBe("dev");
  });

  test.each([...ENVIRONMENTS])("accepts the %s environment", (env) => {
    expect(resolveConfig(appWith({ env })).env).toBe(env);
  });

  test("throws on an unknown environment rather than inventing one", () => {
    expect(() => resolveConfig(appWith({ env: "staging" }))).toThrow(/staging/);
  });

  /**
   * R23 — the flag cannot be derived from the environment name (L974, L976). A
   * dev deploy that can post to production channels is a defect, and so is a
   * prod deploy that starts posting before the 48-hour soak.
   */
  /**
   * §10.3's closing rule as a gate rather than a sentence: R23 keeps the
   * schedule off by default, but nothing stopped a prod deploy passing
   * `scheduleEnabled=true`, which is the one action §10.3 forbids.
   *
   * dev is deliberately unaffected — the whole point of dev is to exercise the
   * pipeline before the calibration exists.
   */
  test("refuses to enable the prod schedule while §10.3's recalibration is outstanding", () => {
    expect(() => resolveConfig(appWith({ env: "prod", scheduleEnabled: true }))).toThrow(/10\.3/);
  });

  test("names what is missing, not merely that something is", () => {
    expect(() => resolveConfig(appWith({ env: "prod", scheduleEnabled: true }))).toThrow(
      /recalibration has not been done/,
    );
  });

  test("dev may enable its schedule, because dev cannot post to production channels", () => {
    expect(resolveConfig(appWith({ env: "dev", scheduleEnabled: true })).scheduleEnabled).toBe(
      true,
    );
  });

  test("prod with the schedule disabled is fine — §9.5 step 4 deploys exactly that", () => {
    expect(resolveConfig(appWith({ env: "prod" })).scheduleEnabled).toBe(false);
  });

  test("defaults scheduleEnabled to false in every environment", () => {
    expect(resolveConfig(appWith({ env: "dev" })).scheduleEnabled).toBe(false);
    expect(resolveConfig(appWith({ env: "prod" })).scheduleEnabled).toBe(false);
  });

  /**
   * The opt-in still exists; it is prod that is now gated. This test used prod
   * and had to move to dev when §10.3's rule became a check — the mechanism it
   * covers is "explicit opt-in", and the environment it used was incidental to
   * that.
   */
  test("enables the schedule only when a deploy opts in explicitly", () => {
    expect(resolveConfig(appWith({ env: "dev", scheduleEnabled: true })).scheduleEnabled).toBe(
      true,
    );
  });

  test("accepts the string form a -c flag produces", () => {
    expect(resolveConfig(appWith({ scheduleEnabled: "true" })).scheduleEnabled).toBe(true);
    expect(resolveConfig(appWith({ scheduleEnabled: "false" })).scheduleEnabled).toBe(false);
  });

  /** §11.4 L1043 calls 300 s "a starting value", which makes configurability binding (R19). */
  test("defaults the settle delay to the §3.3 L292 value", () => {
    expect(resolveConfig(appWith({})).settleDelaySeconds).toBe(SETTLE_DELAY_SECONDS);
  });

  test("accepts an override", () => {
    expect(resolveConfig(appWith({ settleDelaySeconds: 60 })).settleDelaySeconds).toBe(60);
  });

  test("accepts the string form a -c flag produces", () => {
    expect(resolveConfig(appWith({ settleDelaySeconds: "120" })).settleDelaySeconds).toBe(120);
  });

  /**
   * SQS caps a queue's DelaySeconds at 900. Validating at synth turns a deploy
   * failure into a build failure, which is the only failure this machine can
   * observe at all.
   */
  test("rejects a settle delay above the SQS cap", () => {
    expect(() => resolveConfig(appWith({ settleDelaySeconds: SQS_MAX_DELAY_SECONDS + 1 }))).toThrow(
      /900/,
    );
  });

  test("rejects a negative or non-numeric settle delay", () => {
    expect(() => resolveConfig(appWith({ settleDelaySeconds: -1 }))).toThrow();
    expect(() => resolveConfig(appWith({ settleDelaySeconds: "soon" }))).toThrow();
  });

  test("exposes a naming helper already bound to the environment", () => {
    expect(resolveConfig(appWith({ env: "prod" })).name("messages")).toBe(
      "telegator-prod-messages",
    );
  });
});
