import { describe, expect, test } from "vitest";
import { cdkArgs, parseDeployArgs } from "./args";

const SECRETS = {
  telegramSecretArn: "arn:aws:secretsmanager:eu-central-1:1:secret:telegator/telegram-abc",
  openRouterSecretArn: "arn:aws:secretsmanager:eu-central-1:1:secret:telegator/openrouter-def",
};

describe("parseDeployArgs", () => {
  test("defaults to a dev diff that changes nothing", () => {
    expect(parseDeployArgs([])).toEqual({
      env: "dev",
      execute: false,
      scheduleEnabled: false,
      reserveConcurrency: true,
    });
  });

  test("--execute is the opt-in", () => {
    expect(parseDeployArgs(["--execute"]).execute).toBe(true);
  });

  test("accepts --env in both spellings", () => {
    expect(parseDeployArgs(["--env", "prod"]).env).toBe("prod");
    expect(parseDeployArgs(["--env=prod"]).env).toBe("prod");
  });

  /**
   * R23 — §9.5 step 4 deploys *prod* with the schedule off, enabling it only at
   * step 7 after a 48-hour soak. So prod must not imply a schedule.
   */
  test("prod does not imply a schedule", () => {
    expect(parseDeployArgs(["--env=prod"]).scheduleEnabled).toBe(false);
  });

  test("--schedule opts in", () => {
    expect(parseDeployArgs(["--schedule"]).scheduleEnabled).toBe(true);
  });

  /** R40 — a cold account's whole quota is 5, so every reservation is rejected. */
  test("--no-reserve-concurrency opts out of R40's reservations", () => {
    expect(parseDeployArgs(["--no-reserve-concurrency"]).reserveConcurrency).toBe(false);
  });

  /**
   * A typo must not read as "no flag given". `--exec` silently ignored would
   * turn an intended deploy into a diff — or, worse, the reverse for a flag
   * that turns something on.
   */
  test("an unknown argument throws rather than being ignored", () => {
    expect(() => parseDeployArgs(["--exec"])).toThrow("--exec");
    expect(() => parseDeployArgs(["--schedule", "--oops"])).toThrow("--oops");
  });

  test("--env with no value throws", () => {
    expect(() => parseDeployArgs(["--env"])).toThrow("--env");
  });
});

describe("cdkArgs", () => {
  test("diffs unless --execute was given", () => {
    expect(cdkArgs(parseDeployArgs([]), SECRETS)[0]).toBe("diff");
    expect(cdkArgs(parseDeployArgs(["--execute"]), SECRETS)[0]).toBe("deploy");
  });

  /**
   * `--all` is a `deploy` option. `cdk diff` answers "Unknown option(s): --all.
   * These will be ignored" and diffs everything regardless — a warning on every
   * dry run, which is the run an operator is supposed to read carefully.
   */
  test("passes --all only when deploying", () => {
    expect(cdkArgs(parseDeployArgs([]), SECRETS)).not.toContain("--all");
    expect(cdkArgs(parseDeployArgs(["--execute"]), SECRETS)).toContain("--all");
  });

  /**
   * The whole reason this script exists rather than a bare `cdk deploy --all`.
   * An omitted ARN does not fail the deploy: `pipeline-stack.ts` falls back to a
   * placeholder env var and a broad prefix grant, so the stack creates cleanly
   * and every model call fails on the first message instead.
   */
  test("always passes both secret ARNs", () => {
    const flat = cdkArgs(parseDeployArgs([]), SECRETS).join(" ");

    expect(flat).toContain(`telegramSecretArn=${SECRETS.telegramSecretArn}`);
    expect(flat).toContain(`openRouterSecretArn=${SECRETS.openRouterSecretArn}`);
  });

  /** Passed even when the default is correct, so the command records what ran. */
  test("passes every context parameter explicitly", () => {
    const flat = cdkArgs(parseDeployArgs([]), SECRETS).join(" ");

    for (const key of ["env=", "scheduleEnabled=", "reserveConcurrency="]) {
      expect(flat).toContain(key);
    }
  });

  test("renders booleans as the strings -c parsing expects", () => {
    const flat = cdkArgs(parseDeployArgs(["--schedule", "--no-reserve-concurrency"]), SECRETS).join(
      " ",
    );

    expect(flat).toContain("scheduleEnabled=true");
    expect(flat).toContain("reserveConcurrency=false");
  });
});
