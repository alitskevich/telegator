import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { sessionKeyFromSecret } from "./config";

/** The slice of `SecretsManagerClient` this uses; injected so tests build none. */
export interface SecretsReadClient {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
}

/**
 * Reads the cookie sealing key from Secrets Manager, once.
 *
 * Same shape as `handlers/publish.ts` for the bot token of §7.6 L663: the ARN is
 * configuration and travels in an environment variable, the value is fetched at
 * runtime. Amplify's server runtime reuses a process across requests, so the
 * cache spares every authenticated page a round trip for a value that does not
 * change — and a failed read is deliberately not cached, so a throttled call at
 * cold start does not disable sign-in for the life of the process.
 */
export function createSessionKeyReader(
  secretArn: string,
  client: SecretsReadClient,
): () => Promise<Uint8Array> {
  let cached: Uint8Array | undefined;

  return async () => {
    if (cached !== undefined) return cached;

    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (response.SecretString === undefined) {
      throw new Error(`secret ${secretArn} has no SecretString`);
    }

    cached = sessionKeyFromSecret(response.SecretString);
    return cached;
  };
}
