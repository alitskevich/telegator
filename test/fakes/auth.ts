import type { Session } from "tg-auth/session";
import type { IdTokenClaims, IdTokenVerifier, UserStatusReader } from "tg-ports/auth";
import { IdTokenClaimsSchema } from "tg-ports/auth";

/**
 * A verifier that accepts only tokens a test has registered — the default is
 * rejection, so a test that forgets to register one fails rather than passing on
 * an unverified token.
 */
export class FakeIdTokenVerifier implements IdTokenVerifier {
  private readonly valid = new Map<string, IdTokenClaims>();

  accept(idToken: string, claims: unknown): void {
    this.valid.set(idToken, IdTokenClaimsSchema.parse(claims));
  }

  async verify(idToken: string): Promise<IdTokenClaims> {
    const claims = this.valid.get(idToken);
    if (!claims) throw new Error("id token failed verification");
    return claims;
  }
}

/**
 * A user directory. Unknown subjects are disabled, matching §8.6's "a new user
 * is created **disabled**" — the safe default is also the specified one.
 */
export class FakeUserStatusReader implements UserStatusReader {
  reads = 0;
  private readonly enabled = new Set<string>();

  enable(sub: string): void {
    this.enabled.add(sub);
  }

  disable(sub: string): void {
    this.enabled.delete(sub);
  }

  async isEnabled(sub: string): Promise<boolean> {
    this.reads += 1;
    return this.enabled.has(sub);
  }
}

/** A verified caller holding `roles`, as `sessionFromIdToken` would produce one. */
export const sessionWith = (sub: string, roles: readonly string[]): Session => ({
  sub,
  roles: [...roles],
  // Far enough ahead that no test runs into it; expiry is the verifier's check.
  expiresAt: Number.MAX_SAFE_INTEGER,
});
