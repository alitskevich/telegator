import { describe, expect, test } from "vitest";
import { callRpc, isForbidden, isUnauthenticated, RpcError } from "./rpc";

const answering =
  (status: number, body: unknown, seen: RequestInit[] = []): typeof fetch =>
  async (_url, init) => {
    seen.push(init ?? {});
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };

describe("callRpc", () => {
  test("posts the action with the token as a bearer credential", async () => {
    const seen: RequestInit[] = [];
    const result = await callRpc(
      answering(200, { result: { roles: ["viewer"] } }, seen),
      "https://api.example/rpc",
      "id.token",
      "whoami",
    );

    expect(result).toEqual({ roles: ["viewer"] });
    expect(seen[0]?.method).toBe("POST");
    expect(new Headers(seen[0]?.headers).get("authorization")).toBe("Bearer id.token");
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ action: "whoami" });
  });

  test("a refusal carries the API's message and status", async () => {
    const call = callRpc(answering(403, { error: "forbidden" }), "u", "t", "runScraper");

    await expect(call).rejects.toBeInstanceOf(RpcError);
    await expect(call).rejects.toMatchObject({ status: 403, message: "forbidden" });
  });

  /** The authorizer answers before the Lambda, in its own non-JSON shape. */
  test("a gateway refusal without a JSON body still says what happened", async () => {
    await expect(callRpc(answering(401, "Unauthorized"), "u", "t", "whoami")).rejects.toMatchObject(
      { status: 401, message: "HTTP 401" },
    );
  });

  test("tells 401 from 403", () => {
    expect(isUnauthenticated(new RpcError(401, "x"))).toBe(true);
    expect(isForbidden(new RpcError(403, "x"))).toBe(true);
    expect(isUnauthenticated(new Error("x"))).toBe(false);
  });
});
