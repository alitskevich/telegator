import { describe, expect, test } from "vitest";
import { httpTokenEndpoint } from "./cognito.js";

const config = {
  hostedUiDomain: "https://telegator.auth.eu-central-1.amazoncognito.com",
  clientId: "client-123",
};

describe("httpTokenEndpoint", () => {
  test("posts the OIDC authorization_code form", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id_token: "id",
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const tokens = await httpTokenEndpoint(config, fetchImpl).exchangeAuthorizationCode(
      "the-code",
      "https://dash.example/api/auth/callback",
    );

    expect(tokens).toEqual({
      idToken: "id",
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
    });

    const [call] = calls;
    expect(call?.url).toBe(`${config.hostedUiDomain}/oauth2/token`);
    expect(call?.init.method).toBe("POST");

    const body = new URLSearchParams(String(call?.init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: "the-code",
      redirect_uri: "https://dash.example/api/auth/callback",
    });
  });

  /**
   * Cognito answers `invalid_grant` with a 400 and a JSON body. Returning that
   * body as if it were a token set would hand an unparsed error to the verifier
   * and produce a confusing failure two steps later.
   */
  test("throws on a non-2xx response", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

    await expect(
      httpTokenEndpoint(config, fetchImpl).exchangeAuthorizationCode(
        "stale",
        "https://dash.example/cb",
      ),
    ).rejects.toThrow(/invalid_grant/);
  });

  test("throws on a 200 whose body is not a token set", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ id_token: "id" }), { status: 200 });

    await expect(
      httpTokenEndpoint(config, fetchImpl).exchangeAuthorizationCode(
        "c",
        "https://dash.example/cb",
      ),
    ).rejects.toThrow();
  });
});
