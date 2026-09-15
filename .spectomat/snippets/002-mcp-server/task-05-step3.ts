import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Environment } from "../infra/lib/config";
import { resourceName } from "../infra/lib/naming";
import { createMessageRepo } from "../lib/db/messages";
import { createSourceRepo } from "../lib/db/sources";
import { createTargetRepo } from "../lib/db/targets";
import { createMcpServer } from "../lib/mcp/server";
import { parseTarget, REGION } from "../lib/ops/target";

/**
 * mcp-server#6.4, #3.1 — the entry point. `npm run mcp [-- --env=<env>]`, or
 * the same command run by an MCP client as its configured server command.
 *
 * `--env` only: `parseTarget` rejects anything else, which is why `--write`
 * style flags used by other scripts do not appear here (D15's
 * `process.argv.slice(2)`, matching every other operational script).
 */

const PackageJson = z.object({ version: z.string() });

const SOURCES_RESOURCE = "sources";
const MESSAGES_RESOURCE = "messages";
const TARGETS_RESOURCE = "targets";

function readVersion(): string {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const raw: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return PackageJson.parse(raw).version;
}

async function main(): Promise<void> {
  const { env } = parseTarget(process.argv.slice(2));

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const sourcesTable = resourceName(env as Environment, SOURCES_RESOURCE);
  const messagesTable = resourceName(env as Environment, MESSAGES_RESOURCE);
  const targetsTable = resourceName(env as Environment, TARGETS_RESOURCE);

  const sources = createSourceRepo({ client, tableName: sourcesTable });
  const messages = createMessageRepo({ client, tableName: messagesTable });
  const targets = createTargetRepo({ client, tableName: targetsTable });

  const version = readVersion();

  // mcp-server#6.5 — stderr, never stdout (§5.5): stdout carries JSON-RPC
  // frames once `connect` runs, and any other byte on it corrupts the stream.
  console.error(
    `telegator mcp: env=${env} region=${REGION} tables=${sourcesTable},${messagesTable},${targetsTable}`,
  );

  const server = createMcpServer({ version, deps: { sources, messages, targets } });
  await server.connect(new StdioServerTransport());
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
