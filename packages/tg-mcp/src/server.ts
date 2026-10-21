import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TOOLS } from "./tools";
import type { CreateMcpServerOptions, McpDeps, ToolDefinition } from "./types";

interface ToolTextResult {
  readonly [key: string]: unknown;
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: true;
}

/**
 * Runs a tool and maps the outcome to MCP content: a result becomes one block of
 * pretty JSON, a throw becomes `isError: true` with its message. Exported so the
 * mapping is testable without a transport.
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

/** Builds an `McpServer` with the registry's tools; every read and write goes through `deps`. */
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
