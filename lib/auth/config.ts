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
  /** 32 random bytes, base64. Sealing key for the session cookie. */
  sessionSecret: "TELEGATOR_SESSION_SECRET",
} as const;

const SESSION_KEY_BYTES = 32;

export interface AuthConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly hostedUiDomain: string;
  readonly appUrl: string;
  readonly sessionKey: Uint8Array;
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
  const sessionKey = Buffer.from(required(env, AUTH_ENV_VARS.sessionSecret), "base64");
  if (sessionKey.length !== SESSION_KEY_BYTES) {
    throw new Error(
      `${AUTH_ENV_VARS.sessionSecret} must decode to ${SESSION_KEY_BYTES} bytes, got ${sessionKey.length}`,
    );
  }

  return {
    region: required(env, AUTH_ENV_VARS.region),
    userPoolId: required(env, AUTH_ENV_VARS.userPoolId),
    clientId: required(env, AUTH_ENV_VARS.userPoolClientId),
    hostedUiDomain: required(env, AUTH_ENV_VARS.hostedUiDomain).replace(/\/+$/, ""),
    appUrl: required(env, AUTH_ENV_VARS.appUrl).replace(/\/+$/, ""),
    sessionKey,
  };
}
