import type { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, test } from "vitest";
import { cognitoUserStatusReader } from "./userStatus";

const SUB = "e4f1a2b3-0000-4000-8000-000000000001";
const POOL = "eu-central-1_abc123";

function client(reply: (command: AdminGetUserCommand) => unknown) {
  const sent: AdminGetUserCommand[] = [];
  return {
    sent,
    // biome-ignore lint/suspicious/noExplicitAny: the SDK's send() overloads are wider than this port.
    send: (async (command: any) => {
      sent.push(command);
      return reply(command);
      // biome-ignore lint/suspicious/noExplicitAny: as above.
    }) as any,
  };
}

describe("cognitoUserStatusReader", () => {
  test("looks the user up by sub in the configured pool", async () => {
    const stub = client(() => ({ Enabled: true }));
    await cognitoUserStatusReader({ userPoolId: POOL }, stub).isEnabled(SUB);

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]?.input).toEqual({ UserPoolId: POOL, Username: SUB });
  });

  test("an enabled user is enabled", async () => {
    expect(
      await cognitoUserStatusReader(
        { userPoolId: POOL },
        client(() => ({ Enabled: true })),
      ).isEnabled(SUB),
    ).toBe(true);
  });

  test("a disabled user is disabled", async () => {
    expect(
      await cognitoUserStatusReader(
        { userPoolId: POOL },
        client(() => ({ Enabled: false })),
      ).isEnabled(SUB),
    ).toBe(false);
  });

  /**
   * §8.6 L788 makes `enabled` the revocation mechanism, so every uncertain
   * answer has to be "no". A user Cognito cannot find, a response with the field
   * absent, or a throttled call must not read as enabled — the alternative is an
   * authorisation check that opens under load.
   */
  test("a deleted user is not enabled", async () => {
    const missing = client(() => {
      throw Object.assign(new Error("User does not exist."), { name: "UserNotFoundException" });
    });
    expect(await cognitoUserStatusReader({ userPoolId: POOL }, missing).isEnabled(SUB)).toBe(false);
  });

  test("an absent Enabled field is not enabled", async () => {
    expect(
      await cognitoUserStatusReader(
        { userPoolId: POOL },
        client(() => ({})),
      ).isEnabled(SUB),
    ).toBe(false);
  });

  test("a throttled call fails closed rather than granting access", async () => {
    const throttled = client(() => {
      throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
    });
    expect(await cognitoUserStatusReader({ userPoolId: POOL }, throttled).isEnabled(SUB)).toBe(
      false,
    );
  });
});
