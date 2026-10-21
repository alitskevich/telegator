import type { Role } from "tg-enums/roles";
import { type Operator, operatorFrom } from "tg-firebase/operators";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ACTIONS } from "./actions";
import { dispatch } from "./function";

vi.mock("tg-firebase/operators", () => ({ operatorFrom: vi.fn() }));

const as = (operator: Operator | null) => vi.mocked(operatorFrom).mockResolvedValue(operator);
const operator = (roles: Role[], enabled = true): Operator => ({ uid: "u1", roles, enabled });
const call = (action: string, input?: unknown) => dispatch({ data: { action, input } }, "Bearer t");
const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error: { status?: number }) => error.status,
  );

beforeEach(() => vi.clearAllMocks());

describe("dispatch", () => {
  test.each(Object.keys(ACTIONS))("%s refuses an anonymous caller", async (action) => {
    as(null);
    expect(await status(call(action))).toBe(401);
  });

  test.each(Object.keys(ACTIONS))("%s refuses a disabled admin", async (action) => {
    as(operator(["admin"], false));
    expect(await status(call(action))).toBe(403);
  });

  test("a viewer may read but not trigger", async () => {
    as(operator(["viewer"]));
    expect(await call("whoami")).toEqual({ email: null, roles: ["viewer"] });
    expect(await status(call("runScraper"))).toBe(403);
    expect(await status(call("upsertRecord"))).toBe(403);
  });

  test("a malformed body or an unknown action is a 400", async () => {
    as(operator(["admin"]));
    expect(await status(dispatch({ action: "whoami" }, "Bearer t"))).toBe(400);
    expect(await status(call("dropDatabase"))).toBe(400);
  });

  test("invalid input is a 400, not a 500", async () => {
    as(operator(["admin"]));
    expect(await status(call("listMessages", { status: "nope" }))).toBe(400);
  });
});
