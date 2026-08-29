import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ENV_VARS } from "../handlers/env.js";
import { createSourceRepo } from "../lib/db/sources.js";
import { parseSeedArgs } from "../lib/seed/args.js";
import { seedSourcesFrom } from "../lib/seed/sources.js";

/**
 * §9.4 — the seed, run by hand during §9.5's cutover.
 *
 * R20: `sources` only. R21: `--data-dir` is required, because the export lives
 * outside this repository and a default that silently found nothing would look
 * like a successful migration of an empty file.
 *
 * Everything worth testing is in `lib/seed/`; this file reads a file, prints,
 * and writes.
 */

async function main(): Promise<void> {
  const { dataDir, write } = parseSeedArgs(process.argv.slice(2));

  const path = join(dataDir, "data-sources.json");
  const sources = seedSourcesFrom(JSON.parse(readFileSync(path, "utf8")));

  console.log(`${path}: ${sources.length} sources`);

  if (!write) {
    // Dry run by default. A migration is hard to undo, so the destructive mode
    // is the one you opt into after reading this list.
    for (const source of sources) {
      console.log(
        `  ${source.id}  status=${source.status ?? "(none)"}  lastCount=${source.lastCount}`,
      );
    }
    console.log("dry run — pass --write to seed the table");
    return;
  }

  const repo = createSourceRepo({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName: requireEnv(ENV_VARS.sourcesTable),
  });

  for (const source of sources) {
    await repo.put(source);
    console.log(`  seeded ${source.id}`);
  }

  console.log(`seeded ${sources.length} sources`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`missing required environment variable ${name}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
