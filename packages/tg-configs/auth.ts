/**
 * The stack-to-API contract for §8.6's token verification, mirroring the role
 * `tg-configs/env.ts` plays for the pipeline Lambdas: one place naming every
 * variable, read once at the edge rather than reached for from inside the
 * session logic.
 */
export const AUTH_ENV_VARS = {
  /** Set by the Lambda runtime. Not declared by the stack. */
  region: "AWS_REGION",
  userPoolId: "TELEGATOR_USER_POOL_ID",
  userPoolClientId: "TELEGATOR_USER_POOL_CLIENT_ID",
} as const;

export interface AuthConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    // Naming the variable matters: a Lambda's init error is the only place an
    // operator learns which one is missing.
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

export function readAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  return {
    region: required(env, AUTH_ENV_VARS.region),
    userPoolId: required(env, AUTH_ENV_VARS.userPoolId),
    clientId: required(env, AUTH_ENV_VARS.userPoolClientId),
  };
}
