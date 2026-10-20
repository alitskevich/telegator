import { describe, expect, test } from "vitest";
import { z } from "zod";
import { fakeMessageRepo, fakeSourceRepo, fakeTargetRepo } from "../../test/fakes/db";
import { callTool } from "./server";
import type { ToolDefinition } from "./tools";

function deps() {
  return { sources: fakeSourceRepo(), targets: fakeTargetRepo(), messages: fakeMessageRepo() };
}

function tool(run: ToolDefinition["run"]): ToolDefinition {
  return { name: "t", description: "d", inputSchema: z.object({}).strict(), run };
}

describe("callTool (MCP-17, MCP-18)", () => {
  test("a successful call answers one text block of pretty JSON that parses back", async () => {
    const result = { created: { id: "chan" } };
    const reply = await callTool(
      tool(async () => result),
      {},
      deps(),
    );

    expect(reply.isError).toBeUndefined();
    expect(reply.content).toHaveLength(1);
    expect(reply.content[0]).toEqual({ type: "text", text: JSON.stringify(result, null, 2) });
    expect(JSON.parse(reply.content[0]?.text ?? "")).toEqual(result);
  });

  test("a thrown Error becomes isError: true with the error's message", async () => {
    const reply = await callTool(
      tool(() => {
        throw new Error("source already exists: chan");
      }),
      {},
      deps(),
    );

    expect(reply.isError).toBe(true);
    expect(reply.content).toEqual([{ type: "text", text: "source already exists: chan" }]);
  });

  test("a thrown non-Error becomes isError: true with its String(...) form", async () => {
    const reply = await callTool(
      tool(() => {
        throw "boom";
      }),
      {},
      deps(),
    );

    expect(reply.isError).toBe(true);
    expect(reply.content).toEqual([{ type: "text", text: "boom" }]);
  });
});
