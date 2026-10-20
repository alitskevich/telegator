import { describe, expect, test } from "vitest";
import { AUTH_ENV_VARS, readAuthConfig } from "./auth";

const complete = {
  [AUTH_ENV_VARS.region]: "eu-central-1",
  [AUTH_ENV_VARS.userPoolId]: "eu-central-1_abc123",
  [AUTH_ENV_VARS.userPoolClientId]: "client-123",
};

describe("readAuthConfig", () => {
  test("reads a complete environment", () => {
    expect(readAuthConfig(complete)).toEqual({
      region: "eu-central-1",
      userPoolId: "eu-central-1_abc123",
      clientId: "client-123",
    });
  });

  test("names the missing variable", () => {
    const { [AUTH_ENV_VARS.userPoolId]: _omitted, ...partial } = complete;
    expect(() => readAuthConfig(partial)).toThrow(AUTH_ENV_VARS.userPoolId);
  });
});
