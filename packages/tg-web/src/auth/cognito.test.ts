import { describe, expect, test } from "vitest";
import {
  authorizeUrl,
  codeExchangeBody,
  logoutUrl,
  needsRefresh,
  REFRESH_MARGIN_MS,
  readCallback,
  redirectUriFor,
  refreshBody,
  tokensFrom,
} from "./cognito";

const config = {
  hostedUiDomain: "https://telegator-dev-users.auth.eu-central-1.amazoncognito.com",
  clientId: "client-123",
};
const NOW = 1_770_000_000_000;

describe("the hosted-UI URLs", () => {
  test("the redirect is the origin's root, with exactly one slash", () => {
    expect(redirectUriFor("https://telegator-581db.web.app")).toBe(
      "https://telegator-581db.web.app/",
    );
    expect(redirectUriFor("http://localhost:8080/")).toBe("http://localhost:8080/");
  });

  test("authorize asks for a code with an S256 challenge", () => {
    const url = new URL(
      authorizeUrl(config, { redirectUri: "http://localhost:8080/", state: "s", challenge: "c" }),
    );

    expect(url.origin + url.pathname).toBe(`${config.hostedUiDomain}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "http://localhost:8080/",
      scope: "openid email profile",
      state: "s",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
  });

  test("logout returns to the given root", () => {
    const url = new URL(logoutUrl(config, "http://localhost:8080/"));

    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("logout_uri")).toBe("http://localhost:8080/");
  });
});

describe("the token endpoint", () => {
  test("the code exchange sends the verifier and no secret", () => {
    const body = new URLSearchParams(
      codeExchangeBody(config, { code: "k", redirectUri: "http://localhost:8080/", verifier: "v" }),
    );

    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("v");
    expect(body.has("client_secret")).toBe(false);
  });

  test("a refresh sends the refresh token", () => {
    const body = new URLSearchParams(refreshBody(config, "r"));

    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r");
  });

  test("a response becomes tokens that expire when the ID token does", () => {
    expect(tokensFrom({ id_token: "i", refresh_token: "r", expires_in: 3600 }, NOW)).toEqual({
      idToken: "i",
      refreshToken: "r",
      expiresAt: NOW + 3_600_000,
    });
  });

  /** Cognito's refresh answer carries no refresh token; losing it would end the session. */
  test("a refresh keeps the previous refresh token", () => {
    const previous = { idToken: "old", refreshToken: "r", expiresAt: NOW };

    expect(tokensFrom({ id_token: "new", expires_in: 3600 }, NOW, previous)).toMatchObject({
      idToken: "new",
      refreshToken: "r",
    });
  });

  test("a response without an ID token is rejected", () => {
    expect(() => tokensFrom({ access_token: "a", expires_in: 3600 }, NOW)).toThrow();
  });

  test("tokens are refreshed a minute before they expire", () => {
    const tokens = { idToken: "i", expiresAt: NOW + REFRESH_MARGIN_MS + 1 };

    expect(needsRefresh(tokens, NOW)).toBe(false);
    expect(needsRefresh(tokens, NOW + 2)).toBe(true);
  });
});

describe("readCallback", () => {
  test("reads a code and its state", () => {
    expect(readCallback("?code=k&state=s")).toEqual({ kind: "code", code: "k", state: "s" });
  });

  /** The text is attacker-supplied; only the fact of a refusal is kept (§8.6). */
  test("keeps the fact of an error, never its text", () => {
    expect(readCallback("?error=access_denied&error_description=<script>")).toEqual({
      kind: "error",
    });
  });

  test("anything else is no callback", () => {
    expect(readCallback("")).toEqual({ kind: "none" });
    expect(readCallback("?code=k")).toEqual({ kind: "none" });
  });
});
