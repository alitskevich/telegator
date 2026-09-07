import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { requireEnv } from "./env";

/**
 * Reading a Secrets Manager string once per container.
 *
 * §7.6 L699's two secrets, read by three handlers, so the fetch-once-then-cache
 * behaviour is written once. The caller is always a Lambda entry point, whose
 * container lifetime is the natural cache scope.
 *
 * The cache lives in the closure rather than a module-level variable, so two
 * readers in one container cannot overwrite each other's value.
 */

export type SecretReader = () => Promise<string>;

/**
 * Builds a reader for the secret whose ARN is in `arnEnvVar`.
 *
 * `description` names the secret in the error, because "has no string value" is
 * the kind of message an operator reads out of a log with no other context —
 * the same reasoning as `extractText`'s `source` parameter.
 */
export function createSecretReader(
  secrets: SecretsManagerClient,
  arnEnvVar: string,
  description: string,
): SecretReader {
  let cached: string | undefined;

  return async () => {
    if (cached !== undefined) return cached;

    const response = await secrets.send(
      new GetSecretValueCommand({ SecretId: requireEnv(arnEnvVar) }),
    );
    if (response.SecretString === undefined) {
      throw new Error(`the ${description} secret has no string value`);
    }

    cached = response.SecretString;
    return cached;
  };
}

/** One client per container; the reader factory above holds no client of its own. */
export function secretsClient(): SecretsManagerClient {
  return new SecretsManagerClient({});
}
