import { afterEach, describe, expect, test } from "vitest";
import { AUTH_ENV_VARS, readAuthConfig, sessionKeyFromSecret } from "./config.js";

const KEY_BYTES = 32;
const complete = {
  [AUTH_ENV_VARS.region]: "eu-central-1",
  [AUTH_ENV_VARS.userPoolId]: "eu-central-1_abc123",
  [AUTH_ENV_VARS.userPoolClientId]: "client-123",
  [AUTH_ENV_VARS.hostedUiDomain]: "https://telegator.auth.eu-central-1.amazoncognito.com",
  [AUTH_ENV_VARS.appUrl]: "https://dash.example",
  [AUTH_ENV_VARS.sessionSecretArn]:
    "arn:aws:secretsmanager:eu-central-1:000000000000:secret:telegator/session-key",
};

afterEach(() => {
  for (const name of Object.values(AUTH_ENV_VARS)) delete process.env[name];
});

describe("readAuthConfig", () => {
  test("reads a complete environment", () => {
    const config = readAuthConfig(complete);
    expect(config.clientId).toBe("client-123");
    expect(config.appUrl).toBe("https://dash.example");
    expect(config.sessionSecretArn).toMatch(/^arn:aws:secretsmanager:/);
  });

  test("names the missing variable", () => {
    const { [AUTH_ENV_VARS.hostedUiDomain]: _omitted, ...partial } = complete;
    expect(() => readAuthConfig(partial)).toThrow(AUTH_ENV_VARS.hostedUiDomain);
  });

  /**
   * A wrong-length key is the dangerous case: too short and `createCipheriv`
   * throws at the first sign-in, but a plausible-looking one would silently
   * weaken every session cookie and fail like nothing at all.
   */
  test("sessionKeyFromSecret rejects a key that is not 32 bytes", () => {
    expect(() => sessionKeyFromSecret(Buffer.alloc(16).toString("base64"))).toThrow(/32/);
    expect(sessionKeyFromSecret(Buffer.alloc(KEY_BYTES, 7).toString("base64"))).toHaveLength(
      KEY_BYTES,
    );
  });

  test("sessionKeyFromSecret tolerates the trailing newline a console paste leaves", () => {
    expect(sessionKeyFromSecret(`${Buffer.alloc(KEY_BYTES, 3).toString("base64")}\n`)).toHaveLength(
      KEY_BYTES,
    );
  });

  test("trailing slashes on the app url do not double up the callback", () => {
    expect(
      readAuthConfig({ ...complete, [AUTH_ENV_VARS.appUrl]: "https://dash.example/" }).appUrl,
    ).toBe("https://dash.example");
  });
});
