/**
 * §9.3 — the decidable half of `scripts/deploy-web.ts`: which flags it takes,
 * and how the stacks' outputs become the console's `config.json`.
 */

/**
 * No `--env`: the stacks carry the same names in both accounts, so the AWS
 * credentials decide which one is read, and there is one Hosting site. A flag
 * that only labelled the output would claim a choice the script does not make.
 */
export interface WebDeployArgs {
  /** Deploy for real. Without it the script writes the config, builds, and stops. */
  readonly execute: boolean;
  /** Write `config.json` and stop: what `npm run dev` needs against a deployed stack. */
  readonly configOnly: boolean;
}

/** Unknown flags throw, as in `tg-ops/target.ts`: a typo must not change what runs. */
export function parseWebDeployArgs(argv: readonly string[]): WebDeployArgs {
  let execute = false;
  let configOnly = false;

  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    else if (arg === "--config-only") configOnly = true;
    else throw new Error(`unknown argument ${arg}`);
  }

  if (execute && configOnly) throw new Error("--execute and --config-only exclude each other");
  return { execute, configOnly };
}

/** The stacks' `CfnOutput` keys (`tg-infra/lib/auth-stack.ts`, `app-stack.ts`). */
export const WEB_OUTPUTS = {
  apiUrl: "ApiUrl",
  userPoolClientId: "UserPoolClientId",
  hostedUiDomain: "HostedUiDomain",
} as const;

export type WebConfigFile = Record<keyof typeof WEB_OUTPUTS, string>;

/**
 * Picks the console's three values out of the stacks' outputs. A missing one
 * is named, because the alternative is a console that loads and then cannot
 * sign in, with nothing on screen to say why.
 */
export function webConfigFromOutputs(
  outputs: Readonly<Record<string, string | undefined>>,
): WebConfigFile {
  const read = (key: string): string => {
    const value = outputs[key];
    if (value === undefined || value === "") {
      throw new Error(`stack output ${key} is missing; deploy the Auth and App stacks first`);
    }
    return value;
  };

  return {
    apiUrl: read(WEB_OUTPUTS.apiUrl),
    userPoolClientId: read(WEB_OUTPUTS.userPoolClientId),
    hostedUiDomain: read(WEB_OUTPUTS.hostedUiDomain),
  };
}
