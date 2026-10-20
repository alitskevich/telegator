import { AuthorizationError } from "tg-auth/session";
import { describe, expect, test } from "vitest";
import { fakeApiPorts } from "../../test/fakes/api";
import { FakeUserStatusReader, sessionWith } from "../../test/fakes/auth";
import { ACTION_NAMES, ACTIONS } from "./actions";

const SUB = "e4f1a2b3-0000-4000-8000-000000000001";

/**
 * §8.6 — "No code path skips authorisation." The registry is the dashboard's
 * whole reach, so the rule is checked per entry rather than trusted per file: a
 * new action that forgot its role check fails here by name.
 */
describe("every action authorises (§8.6)", () => {
  test("the registry is not empty", () => {
    expect(ACTION_NAMES.length).toBeGreaterThanOrEqual(18);
  });

  test.each(ACTION_NAMES)("%s refuses an anonymous caller", async (name) => {
    const ports = fakeApiPorts();
    const deps = { ...ports, auth: { session: null, status: new FakeUserStatusReader() } };

    await expect(ACTIONS[name]({}, deps)).rejects.toBeInstanceOf(AuthorizationError);
    // Refused before acting: nothing was invoked on the caller's behalf.
    expect(ports.invocations).toEqual([]);
  });

  test.each(ACTION_NAMES)("%s refuses a disabled admin", async (name) => {
    const deps = {
      ...fakeApiPorts(),
      auth: { session: sessionWith(SUB, ["admin"]), status: new FakeUserStatusReader() },
    };

    await expect(ACTIONS[name]({}, deps)).rejects.toMatchObject({ reason: "disabled" });
  });
});

describe("the reads", () => {
  const signedIn = (roles: readonly string[]) => {
    const status = new FakeUserStatusReader();
    status.enable(SUB);
    return { ...fakeApiPorts(), auth: { session: sessionWith(SUB, roles), status } };
  };

  test("whoami answers the caller's roles", async () => {
    await expect(ACTIONS.whoami(undefined, signedIn(["editor"]))).resolves.toEqual({
      sub: SUB,
      email: null,
      roles: ["editor"],
    });
  });

  test("a viewer lists a Messages tab", async () => {
    await expect(
      ACTIONS.listMessages({ status: "topublish" }, signedIn(["viewer"])),
    ).resolves.toEqual([]);
  });

  test("an unknown tab is rejected rather than read", async () => {
    await expect(
      ACTIONS.listMessages({ status: "drafts" }, signedIn(["viewer"])),
    ).rejects.toThrow();
  });

  test("a viewer loads all three queues", async () => {
    const rows = await ACTIONS.loadQueues(undefined, signedIn(["viewer"]));
    expect(rows).toHaveLength(3);
  });
});
