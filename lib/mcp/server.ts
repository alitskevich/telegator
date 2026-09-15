import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps, ToolDefinition } from "./tools";
import { TOOLS } from "./tools";

export interface CreateMcpServerOptions {
  readonly version: string;
  readonly deps: McpDeps;
}

interface ToolTextResult {
  readonly [key: string]: unknown;
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: true;
}

/**
 * mcp-server#3.5 — every tool failure reaches the client the same way:
 * `{ isError: true, content: [{ type: "text", text: "<error.message>" }] }`,
 * with a non-`Error` throw stringified by `String(...)`. A successful call
 * answers one text block of `JSON.stringify(result, null, 2)` (D10).
 *
 * Exported on its own so the mapping is testable without a transport: it takes
 * any `ToolDefinition`, not just the registry's three, so a test can exercise
 * both a resolving and a throwing `run`.
 */
export async function callTool(
  tool: ToolDefinition,
  raw: unknown,
  deps: McpDeps,
): Promise<ToolTextResult> {
  try {
    const result = await tool.run(raw, deps);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text }] };
  }
}

/**
 * mcp-server#6.1 — the SDK adapter. Builds an `McpServer`, registers the
 * registry's tools, and maps every result through `callTool`. Knows no AWS:
 * every read and write goes through `deps`.
 */
export function createMcpServer({ version, deps }: CreateMcpServerOptions): McpServer {
  const server = new McpServer({ name: "telegator", version });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (rawArgs: unknown) => callTool(tool, rawArgs, deps),
    );
  }

  return server;
}
