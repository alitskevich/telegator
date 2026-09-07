import { spawnSync } from "node:child_process";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { Environment } from "../infra/lib/config";
import { resourceName } from "../infra/lib/naming";
import { cdkArgs, type DeploySecrets, parseDeployArgs } from "../lib/deploy/args";
import { REGION } from "../lib/ops/target";

/**
 * §9.5's deploy, as a command.
 *
 * `npx cdk deploy --all` on its own is not this. It deploys *cleanly* against a
 * stack whose Lambdas are pointed at placeholder secret ARNs, because
 * `pipeline-stack.ts` falls back rather than failing when a context parameter is
 * absent — so the failure surfaces on the first Telegram post and the first
 * classification, not at deploy time. Resolving the two ARNs is the job.
 *
 * Everything decidable is in `lib/deploy/args.ts` where a test can reach it.
 * This file resolves ARNs, checks who is deploying, and spawns `cdk`.
 *
 *   npm run deploy                    # dev, diff only — changes nothing
 *   npm run deploy -- --execute       # dev, for real
 *   npm run deploy -- --env=prod --execute
 *
 * Deploying is opt-in for `seed.ts`'s reason, only more so: §7.2's tables carry
 * `RETAIN` with fixed names, so a change that *replaces* one orphans the table
 * and the next deploy cannot reuse the name. Read the diff first.
 */

/**
 * The secrets' names, derived rather than written down.
 *
 * §7.6 writes them as `telegator/telegram-bot-token`, but nothing in this
 * account is named that way: the deployed secrets are `telegator-dev-*`,
 * because §9.2 L896's `telegator-{env}-{resource}` scheme is what every other
 * resource follows. `resourceName` is the same function the stacks use, so a
 * rename cannot leave this script pointing at the old name — and the `{env}`
 * segment means `--env=prod` looks up prod's secrets, never dev's.
 *
 * Either can be overridden by name when a secret does not follow the scheme.
 */
function secretNames(env: string): { telegram: string; openRouter: string } {
  const named = (resource: string) => resourceName(env as Environment, resource);

  return {
    telegram: process.env.TELEGATOR_TELEGRAM_SECRET_NAME ?? named("telegram-token"),
    openRouter: process.env.TELEGATOR_OPENROUTER_SECRET_NAME ?? named("openrouter-key"),
  };
}

/**
 * Refuses a deploy the CDK bootstrap roles cannot serve.
 *
 * The account root can create anything and assume nothing, so `cdk deploy` as
 * root fails partway through on `sts:AssumeRole` for the bootstrap roles —
 * after the first stacks have already changed. Caught here it costs a second.
 */
async function assertDeployIdentity(): Promise<string> {
  const sts = new STSClient({ region: REGION });
  const { Arn: arn } = await sts.send(new GetCallerIdentityCommand({}));

  if (arn === undefined) throw new Error("could not determine the calling identity");
  if (arn.endsWith(":root")) {
    throw new Error(
      `refusing to deploy as the account root (${arn}). Root cannot assume the CDK ` +
        "bootstrap roles, so the deploy fails partway through. Use the deploy user.",
    );
  }

  return arn;
}

/**
 * Resolves a secret's full ARN from its name.
 *
 * By name rather than by hand-copied ARN: Secrets Manager appends a random
 * six-character suffix, so the ARN cannot be derived from the name and a
 * mistyped one produces a grant that authorizes nothing — which, again, deploys
 * cleanly and fails only at runtime.
 */
async function resolveSecret(secrets: SecretsManagerClient, name: string): Promise<string> {
  try {
    const { ARN: arn } = await secrets.send(new DescribeSecretCommand({ SecretId: name }));
    if (arn === undefined) throw new Error(`secret ${name} has no ARN`);
    return arn;
  } catch (error) {
    throw new Error(
      `cannot resolve the secret ${name}: ${error instanceof Error ? error.message : String(error)}\n` +
        `  Create it first:  aws secretsmanager create-secret --name ${name} ` +
        "--secret-string '<value>' --region " +
        REGION,
    );
  }
}

async function main(): Promise<void> {
  const args = parseDeployArgs(process.argv.slice(2));
  const identity = await assertDeployIdentity();

  const client = new SecretsManagerClient({ region: REGION });
  const names = secretNames(args.env);
  const secrets: DeploySecrets = {
    telegramSecretArn: await resolveSecret(client, names.telegram),
    openRouterSecretArn: await resolveSecret(client, names.openRouter),
  };

  console.log(`env      ${args.env}`);
  console.log(`region   ${REGION}`);
  console.log(`identity ${identity}`);
  console.log(`schedule ${args.scheduleEnabled ? "ENABLED" : "disabled"}`);
  console.log(`telegram ${secrets.telegramSecretArn}`);
  console.log(`model    ${secrets.openRouterSecretArn}`);
  console.log(
    args.execute
      ? "\nDeploying for real.\n"
      : "\nDiff only — nothing will change. Add --execute to deploy.\n",
  );

  const cdk = cdkArgs(args, secrets);
  const result = spawnSync("npx", ["cdk", ...cdk], {
    stdio: "inherit",
    env: { ...process.env, AWS_REGION: REGION, CDK_DEFAULT_REGION: REGION },
  });

  process.exit(result.status ?? 1);
}

await main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
