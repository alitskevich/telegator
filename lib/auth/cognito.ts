import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import {
  type IdTokenClaims,
  IdTokenClaimsSchema,
  type IdTokenVerifier,
  type TokenEndpoint,
  type TokenSet,
} from "./ports.js";

/**
 * The production adapters for §8.6 L780's hosted UI. Both are network calls, and
 * both sit behind the ports in `./ports.ts` so nothing in the test suite reaches
 * for them.
 */

const OK_MIN = 200;
const OK_MAX = 300;

/** Cognito's `/oauth2/token` response, in its wire spelling. */
const TokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number(),
});

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface TokenEndpointConfig {
  readonly hostedUiDomain: string;
  readonly clientId: string;
}

/**
 * The app client is created with `generateSecret: false` (`infra/lib/auth-stack.ts`),
 * because a browser-delivered dashboard cannot keep one — so the exchange is
 * authenticated by the registered `redirect_uri` and the `state` check in
 * `./routes.ts`, and sends no client secret.
 */
export function httpTokenEndpoint(
  config: TokenEndpointConfig,
  fetchImpl: FetchLike = fetch,
): TokenEndpoint {
  return {
    async exchangeAuthorizationCode(code, redirectUri) {
      const response = await fetchImpl(`${config.hostedUiDomain}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });

      const body = await response.text();
      if (response.status < OK_MIN || response.status >= OK_MAX) {
        throw new Error(`token exchange failed (${response.status}): ${body}`);
      }

      const parsed = TokenResponseSchema.parse(JSON.parse(body));

      return {
        idToken: parsed.id_token,
        accessToken: parsed.access_token,
        ...(parsed.refresh_token === undefined ? {} : { refreshToken: parsed.refresh_token }),
        expiresIn: parsed.expires_in,
      } satisfies TokenSet;
    },
  };
}

export interface IdTokenVerifierConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
}

/**
 * Verifies signature, issuer and audience against the pool's published JWKS.
 *
 * Verification is the whole security boundary: the claims decide the role, so an
 * unverified decode would let anyone mint themselves `admin` by editing a token.
 * `createRemoteJWKSet` caches the key set, so this is not a network call per
 * request.
 */
export function jwksIdTokenVerifier(config: IdTokenVerifierConfig): IdTokenVerifier {
  const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return {
    async verify(idToken): Promise<IdTokenClaims> {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer,
        audience: config.clientId,
      });

      // `jose` checks `exp` itself; parsing here is what guarantees the claims
      // this app reads are the shape it expects rather than whatever arrived.
      return IdTokenClaimsSchema.parse(payload);
    },
  };
}
