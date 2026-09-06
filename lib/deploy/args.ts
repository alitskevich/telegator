/**
 * Flags for `scripts/deploy.ts`, parsed apart from the deploying.
 *
 * Same split as `lib/seed/args.ts`: the rule is here where a test can reach it,
 * the effect is in `scripts/`. And the same default — the destructive mode is
 * the one you opt into after reading what it would do. `cdk deploy` is harder
 * to undo than a seed: §7.2's tables carry `RETAIN`, so a replacement orphans
 * them under a name the next deploy cannot reuse.
 *
 * The environment name is passed through as a string rather than validated
 * here. `resolveConfig` already rejects an unknown one by name at synth
 * ("unknown environment x; expected one of dev, prod"), and `lib/` does not
 * import `infra/` — the dependency runs the other way.
 */

export interface DeployArgs {
  /** §9.2 L810's `-c env`. */
  readonly env: string;
  /** Opt-in. Without it the script diffs and changes nothing. */
  readonly execute: boolean;
  /**
   * R23 — off unless asked, in **both** environments. §9.5 step 4 deploys prod
   * with the schedule disabled and enables it only at step 7, after a 48-hour
   * soak, so this cannot be inferred from the environment name.
   */
  readonly scheduleEnabled: boolean;
  /**
   * R40 — a reservation is creatable only while the account keeps 5 concurrent
   * executions unreserved, and a cold account's entire quota is 5. Pass
   * `--no-reserve-concurrency` on an account AWS has not raised yet, or the
   * stack cannot be created at all.
   */
  readonly reserveConcurrency: boolean;
}

const ENV = "--env";
const EXECUTE = "--execute";
const SCHEDULE = "--schedule";
const NO_RESERVE = "--no-reserve-concurrency";

const DEFAULT_ENV = "dev";

/**
 * Parses the flags.
 *
 * An unrecognised argument throws rather than being ignored, for `seed/args.ts`'s
 * reason: a typo read as "no flag given" silently changes what runs, and here
 * that could mean deploying prod with a schedule nobody asked for.
 */
export function parseDeployArgs(argv: readonly string[]): DeployArgs {
  let env = DEFAULT_ENV;
  let execute = false;
  let scheduleEnabled = false;
  let reserveConcurrency = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === EXECUTE) {
      execute = true;
    } else if (arg === SCHEDULE) {
      scheduleEnabled = true;
    } else if (arg === NO_RESERVE) {
      reserveConcurrency = false;
    } else if (arg.startsWith(`${ENV}=`)) {
      env = arg.slice(ENV.length + 1);
    } else if (arg === ENV) {
      index += 1;
      env = argv[index] ?? "";
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (env === "") throw new Error(`${ENV} needs a value`);

  return { env, execute, scheduleEnabled, reserveConcurrency };
}

/** The two Secrets Manager ARNs the pipeline's functions are granted and read. */
export interface DeploySecrets {
  /** §7.6 L663 — `publish` reads the bot token. */
  readonly telegramSecretArn: string;
  /** §7.6, as revised by R50 — `analyze` and `aggregate` read the model key. */
  readonly openRouterSecretArn: string;
}

/**
 * Builds the `cdk` argument list.
 *
 * Every parameter `resolveConfig` and `pipeline-stack.ts` read is passed
 * explicitly, including the ones whose defaults would be correct. A deploy that
 * relies on a default is a deploy whose behaviour is not in the command that
 * ran it, and `cdk.json` has no `context` entry for any of them — an omitted
 * secret ARN does not fail, it deploys a Lambda pointed at a placeholder that
 * fails on the first message instead.
 */
export function cdkArgs(args: DeployArgs, secrets: DeploySecrets): string[] {
  return [
    // `--all` is a `deploy` option only: `cdk diff` rejects it with "Unknown
    // option(s): --all. These will be ignored", and diffs every stack anyway.
    ...(args.execute ? ["deploy", "--all"] : ["diff"]),
    "-c",
    `env=${args.env}`,
    "-c",
    `scheduleEnabled=${String(args.scheduleEnabled)}`,
    "-c",
    `reserveConcurrency=${String(args.reserveConcurrency)}`,
    "-c",
    `telegramSecretArn=${secrets.telegramSecretArn}`,
    "-c",
    `openRouterSecretArn=${secrets.openRouterSecretArn}`,
  ];
}
