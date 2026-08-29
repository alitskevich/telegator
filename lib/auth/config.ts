/**
 * The stack-to-dashboard contract for §8.6's hosted UI, mirroring the role
 * `handlers/env.ts` plays for the Lambdas: one place naming every variable, read
 * once at the edge rather than reached for from inside the session logic.
 */
export const AUTH_ENV_VARS = {
  /** Set by the Amplify runtime, like Lambda's. Not declared by the stack. */
  region: "AWS_REGION",
  userPoolId: "TELEGATOR_USER_POOL_ID",
  userPoolClientId: "TELEGATOR_USER_POOL_CLIENT_ID",
  hostedUiDomain: "TELEGATOR_COGNITO_DOMAIN",
  appUrl: "TELEGATOR_APP_URL",
  /**
   * ARN of the Secrets Manager secret holding the cookie sealing key, following
   * `handlers/publish.ts` for the bot token: the *ARN* is configuration, the
   * secret is fetched at runtime. An Amplify environment variable holding the
   * key itself would be readable by anyone who can describe the app, and this
   * key forges admin sessions.
   */
  sessionSecretArn: "TELEGATOR_SESSION_SECRET_ARN",
} as const;

export const SESSION_KEY_BYTES = 32;

export interface AuthConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly hostedUiDomain: string;
  readonly appUrl: string;
  readonly sessionSecretArn: string;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    // Naming the variable matters: an operator reading an Amplify build log has
    // no other way to tell which of six is missing.
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

export function readAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  return {
    region: required(env, AUTH_ENV_VARS.region),
    userPoolId: required(env, AUTH_ENV_VARS.userPoolId),
    clientId: required(env, AUTH_ENV_VARS.userPoolClientId),
    hostedUiDomain: required(env, AUTH_ENV_VARS.hostedUiDomain).replace(/\/+$/, ""),
    appUrl: required(env, AUTH_ENV_VARS.appUrl).replace(/\/+$/, ""),
    sessionSecretArn: required(env, AUTH_ENV_VARS.sessionSecretArn),
  };
}

/**
 * Decode the secret's string value into an AES-256 key.
 *
 * Checked rather than assumed: a short key would be rejected by `createCipheriv`
 * at the first sign-in, but a *wrong-length-yet-valid* one would silently weaken
 * every cookie, and the failure would look like nothing at all.
 */
export function sessionKeyFromSecret(secretString: string): Uint8Array {
  const key = Buffer.from(secretString.trim(), "base64");
  if (key.length !== SESSION_KEY_BYTES) {
    throw new Error(
      `${AUTH_ENV_VARS.sessionSecretArn} must hold ${SESSION_KEY_BYTES} base64 bytes, got ${key.length}`,
    );
  }
  return key;
}
