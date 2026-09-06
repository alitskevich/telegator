/**
 * What every operational script needs before it can do anything: which
 * environment, in which region.
 *
 * Extracted when `scripts/scrape.ts` joined `scripts/deploy.ts` and both wanted
 * the same two facts. One definition, for the reason `lib/domain/tags.ts` has
 * one: the second copy is where they drift, and drifting here means a script
 * quietly operating on the wrong environment's resources.
 */

/**
 * §9.2 L810 — one region.
 *
 * Not a flag. A script pointed at another region does not fail; it builds or
 * addresses a second, silent copy of the pipeline, which is far worse than an
 * error. If a second region is ever wanted, that is a spec change, not a
 * command-line option.
 */
export const REGION = "eu-central-1";

const ENV = "--env";
const DEFAULT_ENV = "dev";

export interface Target {
  /**
   * §9.2 L810's environment. Passed through as a string rather than validated
   * against a list: `resolveConfig` already rejects an unknown one by name, and
   * `lib/` does not import `infra/` — the dependency runs the other way.
   */
  readonly env: string;
}

/**
 * Parses `--env`, rejecting anything else.
 *
 * An unrecognised argument throws rather than being ignored, as in
 * `lib/seed/args.ts`: a typo read as "no flag given" silently changes what
 * runs, and here the default is `dev` — so a fumbled `--env prod` would operate
 * on the wrong environment while looking like it worked.
 */
export function parseTarget(argv: readonly string[]): Target {
  let env = DEFAULT_ENV;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg.startsWith(`${ENV}=`)) {
      env = arg.slice(ENV.length + 1);
    } else if (arg === ENV) {
      index += 1;
      env = argv[index] ?? "";
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (env === "") throw new Error(`${ENV} needs a value`);

  return { env };
}
