import type { App } from "aws-cdk-lib";
import { productionBlocker, readCalibrationRecord } from "../../lib/calibration/record";
import { SETTLE_DELAY_SECONDS, SQS_MAX_DELAY_SECONDS } from "../../lib/dedup/constants";
import { type NameOptions, resourceName } from "./naming";

/**
 * Deploy-time configuration, read from CDK context.
 *
 * Context rather than environment lookup, deliberately: `cdk synth` only works
 * without credentials while every stack stays environment-agnostic, so a
 * `StringParameter.valueFromLookup` here would turn the build's one
 * infrastructure gate into an authenticated call.
 */

/** §9.2 L864 — two environments, isolated by AWS account. */
export const ENVIRONMENTS = ["dev", "prod"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export interface TelegatorConfig {
  readonly env: Environment;
  /**
   * R23. §9.5 deploys **prod** with the schedule disabled too, enabling it only
   * after a 48-hour soak against test channels (L942, L944), so this cannot be
   * derived from the environment name: it is its own parameter, `false` in both,
   * and a deploy must opt in.
   */
  readonly scheduleEnabled: boolean;
  /**
   * §3.3 L290 and §7.3 L646. §11.4 L1011 records 300 s as "a starting value",
   * which makes configurability binding (R19) — and R19 also records that SQS
   * FIFO supports only a queue-level delay, so this is a stack parameter rather
   * than something a producer sets per message.
   */
  readonly settleDelaySeconds: number;
  /**
   * R40 — §7.5 L693: a reservation is creatable only while the account keeps 5
   * concurrent executions unreserved, and a cold account's entire quota is 5.
   *
   * Its own parameter rather than a dev-only branch, for R23's reason: the
   * driver is the account's quota, not the environment name. Defaults to `true`,
   * so the document is what deploys unless a deploy says otherwise.
   */
  readonly reserveConcurrency: boolean;
  /** `resourceName` already bound to this environment. */
  name(resource: string, options?: NameOptions): string;
}

function readEnvironment(raw: unknown): Environment {
  if (raw === undefined) return "dev";

  const found = ENVIRONMENTS.find((candidate) => candidate === raw);
  if (found === undefined) {
    throw new Error(
      `unknown environment ${String(raw)}; expected one of ${ENVIRONMENTS.join(", ")}`,
    );
  }
  return found;
}

/** `-c flag=true` arrives as the string "true", not a boolean. */
function readBoolean(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`expected a boolean, received ${String(raw)}`);
}

function readSettleDelay(raw: unknown): number {
  if (raw === undefined) return SETTLE_DELAY_SECONDS;

  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`settleDelaySeconds must be a non-negative integer, received ${String(raw)}`);
  }
  // Validated at synth so an impossible delay is a build failure rather than a
  // deploy failure — the only kind of failure this machine can observe.
  if (value > SQS_MAX_DELAY_SECONDS) {
    throw new Error(
      `settleDelaySeconds ${value} exceeds the SQS maximum of ${SQS_MAX_DELAY_SECONDS}`,
    );
  }
  return value;
}

/**
 * §10.3's closing rule, as a gate rather than a sentence: "Until this is done
 * the pipeline must not publish to production channels."
 *
 * R23 keeps the schedule off by default, but nothing stopped
 * `scheduleEnabled=true` for prod — the one action the rule forbids. dev is
 * exempt: it exists to exercise the pipeline before the calibration does.
 *
 * The check reads a file at synth time, which keeps `cdk synth` credential-free
 * — the property the whole infrastructure gate rests on.
 */
function assertPublishable(env: string, scheduleEnabled: boolean): void {
  if (env !== "prod" || !scheduleEnabled) return;

  const blocker = productionBlocker(readCalibrationRecord());
  if (blocker === null) return;

  throw new Error(
    `cannot enable the prod schedule: ${blocker}. ` +
      "§10.3 is mandatory before production — run the sweep in `lib/calibration/` and " +
      "record the result, or deploy prod with the schedule disabled (§9.5 step 4).",
  );
}

export function resolveConfig(app: App): TelegatorConfig {
  const env = readEnvironment(app.node.tryGetContext("env"));
  const scheduleEnabled = readBoolean(app.node.tryGetContext("scheduleEnabled"), false);

  assertPublishable(env, scheduleEnabled);

  return {
    env,
    scheduleEnabled,
    settleDelaySeconds: readSettleDelay(app.node.tryGetContext("settleDelaySeconds")),
    reserveConcurrency: readBoolean(app.node.tryGetContext("reserveConcurrency"), true),
    name: (resource, options) => resourceName(env, resource, options),
  };
}
