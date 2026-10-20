import type { Environment } from "./config";

/**
 * §9.2 L906 — "Resource names are environment-prefixed" — without saying what
 * the prefix looks like. Recorded scheme: `telegator-{env}-{resource}`.
 *
 * §7.2 L638, §7.3 L651–653 and §7.5 L694–698 all write bare names like
 * `telegator-messages`. Those are read as the *unprefixed base*: the two
 * environments are separate AWS accounts (§9.2 L906), so the prefix is not
 * needed for uniqueness — it is there so a name in a console, a log line or an
 * alarm says which environment produced it.
 */
const PREFIX = "telegator";

export interface NameOptions {
  /**
   * Append `.fifo`. AWS requires the suffix on a FIFO queue and rejects it on a
   * Standard one; §7.3 L652–653 name the FIFO queues without it.
   */
  readonly fifo?: boolean;
}

export function resourceName(
  env: Environment,
  resource: string,
  options: NameOptions = {},
): string {
  const base = `${PREFIX}-${env}-${resource}`;
  return options.fifo === true ? `${base}.fifo` : base;
}
