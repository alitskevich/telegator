import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { Environment } from "../infra/lib/config";
import { resourceName } from "../infra/lib/naming";
import { createSourceRepo } from "../lib/db/sources";
import { parseTarget, REGION } from "../lib/ops/target";
import { legacyTargetPatch } from "../lib/seed/targets";

/**
 * multi-target#8.1 step 1 — copy `tgChannel` into `target` on every live source
 * row that has the former and lacks the latter, BEFORE the code that reads
 * `target` is deployed.
 *
 *   npm run migrate:targets                    # dry run against dev
 *   npm run migrate:targets -- --write
 *   npm run migrate:targets -- --env=prod --write
 *
 * Dry run by default, like the other cutover scripts. `tgChannel` is never
 * removed (D8): the old code still reads it until `npm run deploy`, and the new
 * `SourceSchema` strips it on read, so it is an orphan rather than a hazard.
 * Idempotent: a second run finds `target` everywhere and patches nothing.
 *
 * The scan uses the document client directly rather than `SourceRepo.listAll`,
 * which parses every row through `SourceSchema` and would strip the attribute
 * this script exists to find.
 */

/** §7.2 L633's table, environment-prefixed per §9.2 L896. */
const SOURCES_RESOURCE = "sources";

const WRITE = "--write";

interface Patch {
  readonly id: string;
  readonly target: string;
}

async function scanRaw(client: DynamoDBDocumentClient, tableName: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const output = await client.send(
      new ScanCommand({
        TableName: tableName,
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
      }),
    );
    rows.push(...("Items" in output ? (output.Items ?? []) : []));
    cursor = "LastEvaluatedKey" in output ? output.LastEvaluatedKey : undefined;
  } while (cursor !== undefined);

  return rows;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const write = argv.includes(WRITE);
  // `parseTarget` rejects any argument it does not know, on purpose — so
  // `--write` is taken out before it, not added to it.
  const { env } = parseTarget(argv.filter((arg) => arg !== WRITE));

  const tableName = resourceName(env as Environment, SOURCES_RESOURCE);
  console.log(`${tableName} in ${REGION} — ${write ? "WRITE" : "dry run"}`);

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const rows = await scanRaw(client, tableName);

  const patches: Patch[] = [];
  for (const row of rows) {
    const patch = legacyTargetPatch(row);
    const id = (row as { id?: unknown }).id;
    if (patch === undefined || typeof id !== "string") continue;
    patches.push({ id, target: patch.target });
  }

  for (const patch of patches) {
    console.log(`  ${patch.id}: target <- ${JSON.stringify(patch.target)}`);
  }

  if (write) {
    const repo = createSourceRepo({ client, tableName });
    for (const patch of patches) {
      // A patch, not a put: an operator's concurrent edit survives, and
      // `tgChannel` stays where it is (D8).
      await repo.patch(patch.id, { target: patch.target });
    }
  }

  console.log(
    `\n${write ? "patched" : "would patch"} ${patches.length} of ${rows.length} source row(s)`,
  );
  if (!write) console.log(`dry run — pass ${WRITE} to apply`);
}

await main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
