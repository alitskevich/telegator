import { createLogger } from "tg-utils/logger";
import { beforeEach, describe, expect, test } from "vitest";
import { fakeApiPorts } from "../../test/fakes/api";
import { FakeIdTokenVerifier, FakeUserStatusReader } from "../../test/fakes/auth";
import { recordingSink } from "../../test/fakes/logging";
import { bearerToken, handleRpc, type RpcDeps } from "./http";

const SUB = "e4f1a2b3-0000-4000-8000-000000000001";

let verifier: FakeIdTokenVerifier;
let status: FakeUserStatusReader;
let sink: ReturnType<typeof recordingSink>;
let deps: RpcDeps;

beforeEach(() => {
  verifier = new FakeIdTokenVerifier();
  status = new FakeUserStatusReader();
  sink = recordingSink();
  deps = { ports: fakeApiPorts(), verifier, status, logger: createLogger(sink) };
});

function signedInAs(...groups: string[]): string {
  verifier.accept("id.token", { sub: SUB, "cognito:groups": groups, exp: 2_000_000_000 });
  status.enable(SUB);
  return "Bearer id.token";
}

const call = (authorization: string | undefined, body: unknown) =>
  handleRpc({ authorization, body: JSON.stringify(body) }, deps);

const parsed = (response: { body: string }) => JSON.parse(response.body) as unknown;

describe("bearerToken", () => {
  test("reads the token from a bearer header", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc.def")).toBe("abc.def");
  });

  test("anything else is no token", () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
  });
});

describe("handleRpc", () => {
  test("answers a signed-in viewer's call with its result", async () => {
    const response = await call(signedInAs("viewer"), { action: "whoami" });

    expect(response.status).toBe(200);
    expect(parsed(response)).toEqual({ result: { sub: SUB, email: null, roles: ["viewer"] } });
  });

  test("a void action answers null rather than nothing", async () => {
    const response = await call(signedInAs("editor"), {
      action: "upsertRecord",
      input: { table: "sources", id: "channel-a", delta: { status: "ok" } },
    });

    expect(response.status).toBe(200);
    expect(parsed(response)).toEqual({ result: null });
  });

  /** Refused before the body is read, so a prober learns no action names. */
  test("an anonymous caller is 401 whatever it asks", async () => {
    const response = await call(undefined, { action: "nonsense" });

    expect(response.status).toBe(401);
    expect(parsed(response)).toEqual({ error: "unauthenticated" });
  });

  test("a token the verifier rejects is 401", async () => {
    const response = await call("Bearer forged.token", { action: "whoami" });
    expect(response.status).toBe(401);
  });

  test("a disabled user is 403", async () => {
    const header = signedInAs("admin");
    status.disable(SUB);

    const response = await call(header, { action: "whoami" });

    expect(response.status).toBe(403);
    expect(parsed(response)).toEqual({ error: "disabled" });
  });

  test("a viewer asking for an admin action is 403", async () => {
    const response = await call(signedInAs("viewer"), { action: "runScraper" });

    expect(response.status).toBe(403);
    expect(parsed(response)).toEqual({ error: "forbidden" });
    expect(deps.ports.lambda).toBeDefined();
  });

  test("an unknown action is 400", async () => {
    const response = await call(signedInAs("admin"), { action: "dropTables" });
    expect(response.status).toBe(400);
  });

  test("malformed JSON is 400, not 500", async () => {
    const response = await handleRpc(
      { authorization: signedInAs("admin"), body: "{not json" },
      deps,
    );
    expect(response.status).toBe(400);
  });

  test("input that fails validation is 400 and says why", async () => {
    const response = await call(signedInAs("viewer"), {
      action: "listMessages",
      input: { status: "drafts" },
    });

    expect(response.status).toBe(400);
    expect(parsed(response)).toMatchObject({ error: expect.stringMatching(/^invalid input/) });
  });

  /** The operator needs the reason in the failure toast; the log keeps who and what. */
  test("a failing action is 500 with its message, and is logged", async () => {
    const response = await call(signedInAs("admin"), {
      action: "republishMessage",
      input: { messageId: "example/99" },
    });

    expect(response.status).toBe(500);
    expect(parsed(response)).toEqual({ error: "no such message: example/99" });
    expect(sink.lines.join("\n")).toContain("republishMessage");
  });
});
