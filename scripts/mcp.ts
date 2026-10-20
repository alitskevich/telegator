import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { messages, sources, targets } from "tg-firebase/db";
import { createMcpServer } from "tg-mcp/server";
import { z } from "zod";

/**
 * `npm run mcp` — the MCP server over stdio, on Firestore. It talks to the
 * emulator when FIRESTORE_EMULATOR_HOST is set, else to production through
 * Application Default Credentials (`gcloud auth application-default login`).
 */

const PackageJson = z.object({ version: z.string() });

function readVersion(): string {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  return PackageJson.parse(JSON.parse(readFileSync(packageJsonPath, "utf8"))).version;
}

async function main(): Promise<void> {
  console.error(`telegator mcp: firestore=${process.env.FIRESTORE_EMULATOR_HOST ?? "production"}`);
  const server = createMcpServer({ version: readVersion(), deps: { sources, messages, targets } });
  await server.connect(new StdioServerTransport());
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
