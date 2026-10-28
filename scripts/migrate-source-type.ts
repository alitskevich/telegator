import { FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { SourceType } from "tg-enums/sourceType";
import { sources } from "tg-firebase/db";

/**
 * One-off: renames each source's `via` to `type`, and folds the retired types
 * into `telegram`, which MTProto now reads alone. Reads the raw documents, since
 * `SourceSchema` knows neither. A source with neither is left alone: an absent
 * `type` already means `telegram`.
 * Dry run unless `--write`; a second run finds nothing to do.
 *
 *   npm run migrate:source-type                # dry run
 *   npm run migrate:source-type -- --write
 *
 * Firestore is the emulator when FIRESTORE_EMULATOR_HOST is set, else production.
 */

/** Each retired `via` or `type` value, and what it becomes. */
const NEW_TYPE: Readonly<Record<string, SourceType>> = {
  web: "telegram",
  mtproto: "telegram",
  telegram_channel: "telegram",
  telegram_mtproto: "telegram",
};

const isStale = (doc: QueryDocumentSnapshot): boolean =>
  doc.get("via") !== undefined ||
  ["telegram_channel", "telegram_mtproto"].includes(doc.get("type"));

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  console.log(
    `firestore=${process.env.FIRESTORE_EMULATOR_HOST ?? "production"} ${write ? "WRITE" : "dry run"}`,
  );

  const docs = (await sources.ref.get()).docs.filter(isStale);
  for (const doc of docs) {
    const old = String(doc.get("via") ?? doc.get("type"));
    const type = NEW_TYPE[old];
    if (type === undefined) throw new Error(`${doc.id}: unknown type "${old}"`);
    console.log(`  ${doc.id}: ${old} -> type=${type}`);
    if (write) await doc.ref.update({ type, via: FieldValue.delete() });
  }

  console.log(`\n${write ? "migrated" : "would migrate"} ${docs.length} source(s)`);
}

await main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
