import "server-only";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { cookies } from "next/headers";
import { ENV_VARS } from "../handlers/env.js";
import { readAuthConfig } from "../lib/auth/config.js";
import type { CookieJar, CookieOptions } from "../lib/auth/ports.js";
import type { RequireRoleDeps } from "../lib/auth/session.js";
import { createSessionKeyReader } from "../lib/auth/sessionKey.js";
import { cognitoUserStatusReader } from "../lib/auth/userStatus.js";
import { systemClock } from "../lib/clock.js";
import { createMessageRepo } from "../lib/db/messages.js";
import { createSourceRepo } from "../lib/db/sources.js";

/**
 * The one place a server action reaches for AWS.
 *
 * `server-only` makes an accidental import from a client component a build
 * error rather than a bundle that ships credentials-shaped configuration to a
 * browser. Clients are built at module scope so a warm Amplify instance reuses
 * their connection pools.
 */

const config = readAuthConfig();

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  // The pipeline writes optional attributes as absent rather than null, and a
  // read that resurrected them as null would fail `MessageSchema`.
  marshallOptions: { removeUndefinedValues: true },
});

const readSessionKey = createSessionKeyReader(
  config.sessionSecretArn,
  new SecretsManagerClient({ region: config.region }),
);

const status = cognitoUserStatusReader(
  { userPoolId: config.userPoolId },
  new CognitoIdentityProviderClient({ region: config.region }),
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

export const sources = createSourceRepo({
  client: documents,
  tableName: requireEnv(ENV_VARS.sourcesTable),
});
export const messages = createMessageRepo({
  client: documents,
  tableName: requireEnv(ENV_VARS.messagesTable),
});

/** Adapts Next's request-scoped cookie store to the `CookieJar` port. */
export async function authContext(): Promise<RequireRoleDeps> {
  const store = await cookies();

  const jar: CookieJar = {
    get: (name) => store.get(name)?.value,
    set: (name, value, options: CookieOptions) => store.set(name, value, options),
    delete: (name) => store.delete(name),
  };

  return { jar, key: await readSessionKey(), clock: systemClock, status };
}
