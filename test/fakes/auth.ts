import type {
  CookieJar,
  CookieOptions,
  IdTokenClaims,
  IdTokenVerifier,
  TokenEndpoint,
  TokenSet,
  UserStatusReader,
} from "../../lib/auth/ports.js";
import { IdTokenClaimsSchema } from "../../lib/auth/ports.js";

/** An in-memory cookie store that also records the options each cookie was set with. */
export class FakeCookieJar implements CookieJar {
  private readonly jar = new Map<string, { value: string; options: CookieOptions }>();

  get(name: string): string | undefined {
    return this.jar.get(name)?.value;
  }

  set(name: string, value: string, options: CookieOptions): void {
    this.jar.set(name, { value, options });
  }

  delete(name: string): void {
    this.jar.delete(name);
  }

  /** The full record, so a test can assert `httpOnly` and friends. */
  written(name: string): { value: string; options: CookieOptions } | undefined {
    return this.jar.get(name);
  }
}

/** A token endpoint that answers only for codes a test has registered. */
export class FakeTokenEndpoint implements TokenEndpoint {
  readonly exchanges: { code: string; redirectUri: string }[] = [];
  private readonly responses = new Map<string, TokenSet>();

  expect(code: string, tokens: TokenSet): void {
    this.responses.set(code, tokens);
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<TokenSet> {
    this.exchanges.push({ code, redirectUri });
    const tokens = this.responses.get(code);
    if (!tokens) throw new Error(`invalid_grant: ${code}`);
    return tokens;
  }
}

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
 * A user directory. Unknown subjects are disabled, matching §8.6 L788's "a new
 * user is created **disabled**" — the safe default is also the specified one.
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
