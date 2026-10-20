import { z } from "zod";

/**
 * §8.6 — the browser's half of the Cognito hosted-UI sign-in, as pure
 * functions: what URL to send the operator to, what to post to the token
 * endpoint, and what comes back. `AuthService` does the I/O.
 */

export interface CognitoConfig {
  /** `https://telegator-dev-users.auth.eu-central-1.amazoncognito.com`, no trailing slash. */
  readonly hostedUiDomain: string;
  readonly clientId: string;
}

/**
 * The SPA signs in and out at its root. Cognito compares `redirect_uri` byte
 * for byte against the registered callback, which `tg-infra/lib/web.ts` writes
 * with the same trailing slash.
 */
export const redirectUriFor = (origin: string): string => `${origin.replace(/\/+$/, "")}/`;

const SCOPES = "openid email profile";

export function authorizeUrl(
  config: CognitoConfig,
  params: { readonly redirectUri: string; readonly state: string; readonly challenge: string },
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: params.redirectUri,
    scope: SCOPES,
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
  });
  return `${config.hostedUiDomain}/oauth2/authorize?${query}`;
}

export function logoutUrl(config: CognitoConfig, redirectUri: string): string {
  const query = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri });
  return `${config.hostedUiDomain}/logout?${query}`;
}

export const tokenUrl = (config: CognitoConfig): string => `${config.hostedUiDomain}/oauth2/token`;

/** The authorization-code exchange, with the verifier instead of a client secret. */
export const codeExchangeBody = (
  config: CognitoConfig,
  params: { readonly code: string; readonly redirectUri: string; readonly verifier: string },
): string =>
  new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  }).toString();

export const refreshBody = (config: CognitoConfig, refreshToken: string): string =>
  new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  }).toString();

/** Cognito's `/oauth2/token` answer, in its wire spelling. A refresh omits `refresh_token`. */
const TokenResponseSchema = z.object({
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});

const MS_PER_SECOND = 1000;

/** What the console keeps between page loads. */
export const StoredTokensSchema = z.object({
  idToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
});

export type StoredTokens = z.infer<typeof StoredTokensSchema>;

/**
 * A token response, as tokens to keep. A refresh answer carries no new refresh
 * token, so the previous one is kept rather than lost.
 */
export function tokensFrom(body: unknown, now: number, previous?: StoredTokens): StoredTokens {
  const parsed = TokenResponseSchema.parse(body);
  const refreshToken = parsed.refresh_token ?? previous?.refreshToken;

  return {
    idToken: parsed.id_token,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt: now + parsed.expires_in * MS_PER_SECOND,
  };
}

/**
 * Refreshed a minute early: a token that expires between the check and the
 * API Gateway authorizer is a 401 for a click the operator made in time.
 */
export const REFRESH_MARGIN_MS = 60_000;

export const needsRefresh = (tokens: StoredTokens, now: number): boolean =>
  tokens.expiresAt - REFRESH_MARGIN_MS <= now;

/** What a hosted-UI redirect carried back, read from `location.search`. */
export type Callback =
  | { readonly kind: "none" }
  | { readonly kind: "code"; readonly code: string; readonly state: string }
  | { readonly kind: "error" };

/**
 * `?code=…&state=…`, or `?error=…`. The error's own text is never kept: it is
 * attacker-supplied, so the page shows a fixed sentence rather than echoing it
 * (§8.6).
 */
export function readCallback(search: string): Callback {
  const params = new URLSearchParams(search);
  if (params.has("error")) return { kind: "error" };

  const code = params.get("code");
  const state = params.get("state");
  return code !== null && state !== null ? { kind: "code", code, state } : { kind: "none" };
}
