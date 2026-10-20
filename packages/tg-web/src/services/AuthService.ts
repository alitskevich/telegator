import { WebClientService } from "arrmatura-web";
import { z } from "zod";
import {
  authorizeUrl,
  type CognitoConfig,
  codeExchangeBody,
  logoutUrl,
  needsRefresh,
  readCallback,
  redirectUriFor,
  refreshBody,
  type StoredTokens,
  StoredTokensSchema,
  tokensFrom,
  tokenUrl,
} from "../auth/cognito";
import { codeChallenge, newCodeVerifier, newState } from "../auth/pkce";
import type { WebConfig } from "../config";

/**
 * §8.6 — the operator's Cognito sign-in, done by the browser itself: the
 * hosted UI with PKCE, then the ID token kept for `ApiService` to send.
 *
 * Mounted once as `<AuthService Ref="auth" config="{R.config}" />`. It knows
 * nothing of the API: whether this operator may *use* the console is the API's
 * answer (`whoami`), because only the API can read the live `enabled` flag.
 */

export type AuthStatus = "pending" | "signedOut" | "signedIn";

/** In `localStorage`, so a reload or a second tab stays signed in. */
const TOKENS_KEY = "tokens";

/** In `sessionStorage`: the verifier must not outlive the tab that started the sign-in. */
const PENDING_KEY = "pending";

const PendingSchema = z.object({ state: z.string().min(1), verifier: z.string().min(1) });

export class AuthService extends WebClientService {
  declare config: WebConfig;

  status: AuthStatus = "pending";
  /** The last sign-in came back refused or forged; the page says so in fixed words. */
  refused = false;

  #refreshing: Promise<string> | undefined;

  private get cognito(): CognitoConfig {
    return { hostedUiDomain: this.config.hostedUiDomain, clientId: this.config.userPoolClientId };
  }

  private get redirectUri(): string {
    return redirectUriFor(window.location.origin);
  }

  override __init(): void {
    void this.start();
  }

  get isSignedIn(): boolean {
    return this.status === "signedIn";
  }

  /** Off to the hosted UI. The page unloads; the answer arrives as `?code=` on return. */
  async signIn(): Promise<void> {
    const verifier = newCodeVerifier();
    const state = newState();
    this.sessionStorage.set(PENDING_KEY, { state, verifier });

    const challenge = await codeChallenge(verifier);
    window.location.assign(
      authorizeUrl(this.cognito, { redirectUri: this.redirectUri, state, challenge }),
    );
  }

  /** Ends the hosted-UI session too, or the next sign-in would skip the password. */
  signOut(): void {
    this.localStorage.set(TOKENS_KEY, null);
    window.location.assign(logoutUrl(this.cognito, this.redirectUri));
  }

  /** The API refused the token: forget it and show the sign-in page. */
  expire(): void {
    this.localStorage.set(TOKENS_KEY, null);
    this.up({ status: "signedOut" });
  }

  /** A token fit to send now, refreshed first when it is about to lapse. */
  async idToken(): Promise<string> {
    const tokens = this.tokens();
    if (tokens === undefined) {
      this.expire();
      throw new Error("signed out");
    }
    if (!needsRefresh(tokens, Date.now())) return tokens.idToken;

    // One refresh at a time: a page load fires several calls at once, and
    // Cognito would answer each with a new token for no reason.
    this.#refreshing ??= this.refresh(tokens).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  private tokens(): StoredTokens | undefined {
    const parsed = StoredTokensSchema.safeParse(this.localStorage.get(TOKENS_KEY));
    return parsed.success ? parsed.data : undefined;
  }

  private async start(): Promise<void> {
    const callback = readCallback(window.location.search);

    // The code is single-use and the URL is shown, bookmarked and shared, so it
    // leaves the address bar before anything else happens.
    if (callback.kind !== "none") {
      window.history.replaceState(null, "", `${this.redirectUri}${window.location.hash}`);
    }

    if (callback.kind === "error") {
      this.up({ status: "signedOut", refused: true });
      return;
    }

    if (callback.kind === "code") {
      await this.complete(callback.code, callback.state);
      return;
    }

    this.up({ status: this.tokens() === undefined ? "signedOut" : "signedIn" });
  }

  private async complete(code: string, state: string): Promise<void> {
    const pending = PendingSchema.safeParse(this.sessionStorage.get(PENDING_KEY));
    this.sessionStorage.set(PENDING_KEY, null);

    // A `state` this tab did not issue is a forged or replayed callback.
    if (!pending.success || pending.data.state !== state) {
      this.up({ status: "signedOut", refused: true });
      return;
    }

    try {
      const body = await this.postToken(
        codeExchangeBody(this.cognito, {
          code,
          redirectUri: this.redirectUri,
          verifier: pending.data.verifier,
        }),
      );
      this.localStorage.set(TOKENS_KEY, tokensFrom(body, Date.now()));
      this.up({ status: "signedIn", refused: false });
    } catch (error) {
      this.logError(error);
      this.up({ status: "signedOut", refused: true });
    }
  }

  private async refresh(tokens: StoredTokens): Promise<string> {
    if (tokens.refreshToken === undefined) {
      this.expire();
      throw new Error("signed out");
    }

    try {
      const body = await this.postToken(refreshBody(this.cognito, tokens.refreshToken));
      const next = tokensFrom(body, Date.now(), tokens);
      this.localStorage.set(TOKENS_KEY, next);
      return next.idToken;
    } catch (error) {
      // A revoked or expired refresh token: the operator signs in again.
      this.logError(error);
      this.expire();
      throw error;
    }
  }

  private async postToken(body: string): Promise<unknown> {
    const response = await fetch(tokenUrl(this.cognito), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
    return response.json();
  }
}
