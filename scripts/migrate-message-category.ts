import { FieldValue } from "firebase-admin/firestore";
import { mergeTags, splitTags, TagsSchema } from "tg-domain/tags";
import { messages } from "tg-firebase/db";

/**
 * One-off: folds each message's `category` into its `tags`, category first, as
 * aggregate does, and deletes the field. Reads the raw documents, since
 * `MessageSchema` no longer knows it. `ts` stays: publish renders it into the
 * `#ts_` hashtag, and the status query orders by it.
 * Dry run unless `--write`; a second run finds nothing to do.
 *
 *   npm run migrate:message-category                # dry run
 *   npm run migrate:message-category -- --write
 *
 * Firestore is the emulator when FIRESTORE_EMULATOR_HOST is set, else production.
 */

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  console.log(
    `firestore=${process.env.FIRESTORE_EMULATOR_HOST ?? "production"} ${write ? "WRITE" : "dry run"}`,
  );

  const docs = (await messages.ref.select("category", "tags").get()).docs.filter(
    (doc) => doc.get("category") !== undefined,
  );
  for (const doc of docs) {
    const category = doc.get("category");
    const tags = mergeTags(splitTags(category), TagsSchema.parse(doc.get("tags") ?? []));
    console.log(`  ${doc.id}: ${category} -> [${tags.join(", ")}]`);
    if (write) await doc.ref.update({ tags, category: FieldValue.delete() });
  }

  console.log(`\n${write ? "migrated" : "would migrate"} ${docs.length} message(s)`);
}

await main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
