import { createRemoteJWKSet, jwtVerify } from "jose";
import { type IdTokenClaims, IdTokenClaimsSchema, type IdTokenVerifier } from "tg-ports/auth";

/**
 * The production adapter for §8.6's bearer token. It is a network call (the
 * JWKS fetch), so it sits behind `IdTokenVerifier` and nothing in the test
 * suite reaches for it.
 */

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
 * request on a warm Lambda.
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
