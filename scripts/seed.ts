import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceSchema } from "tg-domain/source";
import { TargetSchema } from "tg-domain/target";
import { sources, targets } from "tg-firebase/db";

/**
 * `npm run seed -- <dir>` — loads `sources` and `targets` from the DynamoDB
 * scan exports in `<dir>` (`sources.dynamodb.json`, `targets.dynamodb.json`).
 * Messages are not carried over. Dry run unless `--write`.
 *
 * Firestore is the emulator when FIRESTORE_EMULATOR_HOST is set, else production.
 */

type AttributeValue = Record<string, unknown>;

/** DynamoDB's typed JSON (`{"S": "x"}`, `{"N": "1"}`, …) to a plain value. */
function unmarshal(value: AttributeValue): unknown {
  const [type, inner] = Object.entries(value)[0] ?? [];
  switch (type) {
    case "S":
    case "BOOL":
      return inner;
    case "N":
      return Number(inner);
    case "NULL":
      return null;
    case "L":
      return (inner as AttributeValue[]).map(unmarshal);
    case "M":
      return unmarshalItem(inner as Record<string, AttributeValue>);
    case "SS":
      return inner;
    case "NS":
      return (inner as string[]).map(Number);
    default:
      throw new Error(`unsupported DynamoDB type: ${type}`);
  }
}

function unmarshalItem(item: Record<string, AttributeValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, unmarshal(value)]));
}

function readScan(dir: string, table: string): Record<string, unknown>[] {
  const scan = JSON.parse(readFileSync(join(dir, `${table}.dynamodb.json`), "utf8"));
  return (scan.Items as Record<string, AttributeValue>[]).map(unmarshalItem);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith("--"));
  if (dir === undefined) throw new Error("usage: npm run seed -- <export dir> [--write]");
  const write = args.includes("--write");

  const sourceRows = readScan(dir, "sources").map((row) => SourceSchema.parse(row));
  const targetRows = readScan(dir, "targets").map((row) => TargetSchema.parse(row));
  console.log(`firestore=${process.env.FIRESTORE_EMULATOR_HOST ?? "production"}`);
  console.log(`${sourceRows.length} sources, ${targetRows.length} targets`);

  if (!write) {
    console.log("dry run — pass --write to apply");
    return;
  }
  for (const row of sourceRows) await sources.put(row);
  for (const row of targetRows) await targets.put(row);
  console.log("written");
}

await main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
