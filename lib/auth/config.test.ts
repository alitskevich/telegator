import { afterEach, describe, expect, test } from "vitest";
import { AUTH_ENV_VARS, readAuthConfig } from "./config.js";

const KEY_BYTES = 32;
const complete = {
  [AUTH_ENV_VARS.region]: "eu-central-1",
  [AUTH_ENV_VARS.userPoolId]: "eu-central-1_abc123",
  [AUTH_ENV_VARS.userPoolClientId]: "client-123",
  [AUTH_ENV_VARS.hostedUiDomain]: "https://telegator.auth.eu-central-1.amazoncognito.com",
  [AUTH_ENV_VARS.appUrl]: "https://dash.example",
  [AUTH_ENV_VARS.sessionSecret]: Buffer.alloc(KEY_BYTES, 7).toString("base64"),
};

afterEach(() => {
  for (const name of Object.values(AUTH_ENV_VARS)) delete process.env[name];
});

describe("readAuthConfig", () => {
  test("reads a complete environment", () => {
    const config = readAuthConfig(complete);
    expect(config.clientId).toBe("client-123");
    expect(config.appUrl).toBe("https://dash.example");
    expect(config.sessionKey).toHaveLength(KEY_BYTES);
  });

  test("names the missing variable", () => {
    const { [AUTH_ENV_VARS.hostedUiDomain]: _omitted, ...partial } = complete;
    expect(() => readAuthConfig(partial)).toThrow(AUTH_ENV_VARS.hostedUiDomain);
  });

  /**
   * A short key would still be accepted by some AES modes and silently weaken
   * every session cookie, so the length is checked rather than assumed.
   */
  test("rejects a session secret that is not 32 bytes", () => {
    expect(() =>
      readAuthConfig({
        ...complete,
        [AUTH_ENV_VARS.sessionSecret]: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrow(/32/);
  });

  test("trailing slashes on the app url do not double up the callback", () => {
    expect(
      readAuthConfig({ ...complete, [AUTH_ENV_VARS.appUrl]: "https://dash.example/" }).appUrl,
    ).toBe("https://dash.example");
  });
});
