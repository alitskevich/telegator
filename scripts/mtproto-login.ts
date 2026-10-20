import { createInterface } from "node:readline/promises";
import {
  CreateSecretCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Environment } from "tg-infra/lib/config";
import { resourceName } from "tg-infra/lib/naming";
import { createMtprotoClient } from "tg-mtproto/client";
import { MTPROTO_SECRET_RESOURCE, type MtprotoCredentials } from "tg-mtproto/credentials";
import { parseTarget, REGION } from "tg-ops/target";

/**
 * R63 — the one interactive step the MTProto scraper needs: log in as a
 * Telegram user and store the session where `scrape-mtproto` reads it.
 *
 *   npm run mtproto:login              # reads ~/.keys/tg-api-id.key and tg-api-hash.key
 *   npm run mtproto:login -- --env=prod
 *
 * It asks for the phone number, the login code and, if set, the 2FA password,
 * then writes `{apiId, apiHash, session}` to `telegator-{env}-mtproto-session`,
 * creating the secret on first use. `npm run deploy` refuses to run until that
 * secret exists, because a Lambda pointed at a missing one fails only at runtime.
 *
 * The session is never printed or written to disk: it is a login to the
 * account, and Secrets Manager is the one place it may live. Re-run this
 * whenever Telegram revokes it — `scrape-mtproto` then logs "not authorised".
 */

const API_ID_VAR = "TG_API_ID";
const API_HASH_VAR = "TG_API_HASH";

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; take it from my.telegram.org → API development tools`);
  }
  return value;
}

/** Overwrites the value when the secret exists, creates it when it does not. */
async function storeSecret(name: string, value: string): Promise<void> {
  const secrets = new SecretsManagerClient({ region: REGION });
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    await secrets.send(new CreateSecretCommand({ Name: name, SecretString: value }));
  }
}

async function main(): Promise<void> {
  const { env } = parseTarget(process.argv.slice(2));
  const secretName = resourceName(env as Environment, MTPROTO_SECRET_RESOURCE);
  const login: MtprotoCredentials = {
    apiId: Number(requireVar(API_ID_VAR)),
    apiHash: requireVar(API_HASH_VAR),
    session: "",
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const client = createMtprotoClient(login);
  try {
    await client.start({
      phoneNumber: () => rl.question("Phone (+31…): "),
      phoneCode: () => rl.question("Login code: "),
      password: () => rl.question("2FA password: "),
      onError: (error) => console.error(error),
    });

    const me = await client.getMe();
    const session = String(client.session.save());
    await storeSecret(secretName, JSON.stringify({ ...login, session }));

    console.log(`logged in as ${me.username ?? me.id.toString()}; session stored in ${secretName}`);
  } finally {
    rl.close();
    await client.destroy();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
