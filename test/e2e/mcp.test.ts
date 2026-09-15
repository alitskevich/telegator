import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test } from "vitest";
import type { Message } from "../../lib/domain/message";
import { createMcpServer } from "../../lib/mcp/server";
import type { McpDeps } from "../../lib/mcp/tools";
import { fakeMessageRepo, fakeSourceRepo, fakeTargetRepo } from "../fakes/db";

/**
 * mcp-server#9.2 — driven by a real SDK `Client` connected to the real
 * `McpServer` over `InMemoryTransport.createLinkedPair()`, with `McpDeps` from
 * `test/fakes/db.ts` (MCP-NF-2: no socket, no pipe, no child process).
 *
 * `test/e2e/harness.ts` is not used: it wires the four pipeline stages, and
 * this subsystem touches none of them (mcp-server#12).
 */

function member(ts: number, summary = "s") {
  return { summary, links: [], channel: "c", ts };
}

function seedMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? "s/1",
    status: overrides.status ?? "published",
    members: overrides.members ?? { i1: member(1) },
    memberCount: overrides.memberCount ?? 1,
    keyEntities: [],
    keyTitle: [],
    keyTags: [],
    memberIds: [],
    date: overrides.date ?? "2026-01-01",
    tags: overrides.tags ?? "Minsk",
    tgChannel: "telegator_news",
    posts: {},
    ts: overrides.ts ?? 1,
    ...overrides,
  };
}

interface World {
  readonly client: Client;
  readonly deps: McpDeps;
}

async function connectedWorld(deps: McpDeps): Promise<World> {
  const server = createMcpServer({ version: "0.0.0-test", deps });
  const client = new Client({ name: "test-client", version: "0.0.0-test" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, deps };
}

function deps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    sources: fakeSourceRepo(),
    targets: fakeTargetRepo(),
    messages: fakeMessageRepo(),
    ...overrides,
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [block] = result.content as Array<{ type: string; text: string }>;
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

describe("the MCP server end-to-end", () => {
  let world: World;

  beforeEach(async () => {
    world = await connectedWorld(deps());
  });

  test("tools/list returns the three MCP-15 names with input schemas, and an unknown tool call fails (MCP-E2E-1)", async () => {
    const { tools } = await world.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      ["add_source", "add_target", "find_messages_by_tags"].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }

    const result = await world.client.callTool({ name: "no_such_tool", arguments: {} });
    expect(result.isError).toBe(true);
  });

  test("add_source then add_target leave exactly one canonicalised row each (MCP-E2E-2)", async () => {
    const sources = fakeSourceRepo();
    const targets = fakeTargetRepo();
    world = await connectedWorld(deps({ sources, targets }));

    await world.client.callTool({
      name: "add_source",
      arguments: { id: "@chan", tags: "minsk" },
    });
    await world.client.callTool({ name: "add_target", arguments: { id: "@b" } });

    expect(await sources.get("chan")).toMatchObject({ id: "chan", tags: "minsk" });
    expect(await targets.get("b")).toMatchObject({ id: "b" });
    expect((await sources.listAll()).length).toBe(1);
    expect((await targets.listAll()).length).toBe(1);
  });

  test("find_messages_by_tags returns a parsed payload with matched, returned and member summaries (MCP-E2E-3)", async () => {
    const messages = fakeMessageRepo([
      seedMessage({ id: "s/1", tags: "Minsk", ts: 1 }),
      seedMessage({ id: "s/2", tags: "Minsk", ts: 2 }),
      seedMessage({ id: "s/3", tags: "Minsk", ts: 3, members: { m1: member(1, "hi") } }),
    ]);
    world = await connectedWorld(deps({ messages }));

    const result = await world.client.callTool({
      name: "find_messages_by_tags",
      arguments: { tags: ["Minsk"], limit: 2 },
    });

    const payload = JSON.parse(textOf(result)) as {
      matched: number;
      returned: number;
      messages: Array<{ id: string; members: Array<{ summary: string }> }>;
    };

    expect(payload.matched).toBe(3);
    expect(payload.returned).toBe(2);
    expect(payload.messages.map((m) => m.id)).toEqual(["s/3", "s/2"]);
    expect(payload.messages[0]?.members.map((m) => m.summary)).toEqual(["hi"]);
  });

  test("add_source called twice with the same id errors the second time and leaves the first row unchanged (MCP-E2E-4)", async () => {
    const sources = fakeSourceRepo();
    world = await connectedWorld(deps({ sources }));

    const first = await world.client.callTool({ name: "add_source", arguments: { id: "@chan" } });
    expect(first.isError).toBeUndefined();

    const second = await world.client.callTool({
      name: "add_source",
      arguments: { id: "@chan" },
    });

    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("chan");
    expect(await sources.get("chan")).toMatchObject({ id: "chan" });
  });
});
