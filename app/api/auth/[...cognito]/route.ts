import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { cookies } from "next/headers";
import { httpTokenEndpoint, jwksIdTokenVerifier } from "../../../../lib/auth/cognito";
import { readAuthConfig } from "../../../../lib/auth/config";
import type { CookieJar, CookieOptions } from "../../../../lib/auth/ports";
import { handleAuthRequest } from "../../../../lib/auth/routes";
import { createSessionKeyReader } from "../../../../lib/auth/sessionKey";
import { systemClock } from "../../../../lib/clock";

/**
 * §8.2 L722. A thin wrapper, exactly like the Lambda entry points in `handlers/`:
 * it adapts Next's request-scoped cookie store to the `CookieJar` port, reads
 * configuration once, and hands the decision to `lib/auth/routes.ts` — which is
 * where the tests are.
 */

// Sign-in mutates cookies and must never be prerendered or cached.
export const dynamic = "force-dynamic";

type NextCookies = Awaited<ReturnType<typeof cookies>>;

function cookieJar(store: NextCookies): CookieJar {
  return {
    get: (name) => store.get(name)?.value,
    set: (name, value, options: CookieOptions) => store.set(name, value, options),
    delete: (name) => store.delete(name),
  };
}

/**
 * Module scope, so the SDK client and the fetched key survive between requests
 * on a warm Amplify server instance.
 */
const config = readAuthConfig();
const readSessionKey = createSessionKeyReader(
  config.sessionSecretArn,
  new SecretsManagerClient({ region: config.region }),
);

export async function GET(
  request: Request,
  context: { params: Promise<{ cognito?: string[] }> },
): Promise<Response> {
  const { cognito = [] } = await context.params;

  return handleAuthRequest(cognito, request, {
    tokens: httpTokenEndpoint(config),
    verifier: jwksIdTokenVerifier(config),
    jar: cookieJar(await cookies()),
    key: await readSessionKey(),
    clock: systemClock,
    config: {
      hostedUiDomain: config.hostedUiDomain,
      clientId: config.clientId,
      appUrl: config.appUrl,
    },
  });
}
