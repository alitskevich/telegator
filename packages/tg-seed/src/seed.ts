import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "tg-firebase/app";

/**
 * Seed snapshots: the operator-curated collections as JSON, one file per
 * collection, `{ "<document id>": { ...fields } }`. Documents are stored raw,
 * soft-deleted ones too, so an upload restores exactly what was downloaded.
 */

/** What an operator curates. Everything else is produced by the pipeline. */
export const SEED_COLLECTIONS = ["sources", "targets", "users"] as const;

export type SeedCollection = (typeof SEED_COLLECTIONS)[number];

/** One collection's documents, keyed by document id. */
export type Snapshot = Record<string, Record<string, unknown>>;

export async function download(name: SeedCollection): Promise<Snapshot> {
  const snap = await db.collection(name).get();
  return Object.fromEntries(snap.docs.map((doc) => [doc.id, doc.data()]));
}

/**
 * Makes the collection match `docs`: every document is overwritten whole, and
 * one missing from `docs` is deleted. Nothing is written unless `write`.
 */
export async function upload(
  name: SeedCollection,
  docs: Snapshot,
  write: boolean,
): Promise<{ written: number; deleted: number }> {
  const ref = db.collection(name);
  const stale = (await ref.listDocuments()).filter((doc) => !Object.hasOwn(docs, doc.id));
  const ids = Object.keys(docs);

  if (write) {
    const writer = db.bulkWriter();
    for (const id of ids) void writer.set(ref.doc(id), docs[id] ?? {});
    for (const doc of stale) void writer.delete(doc);
    await writer.close();
  }
  return { written: ids.length, deleted: stale.length };
}

const fileOf = (dir: string, name: SeedCollection) => join(dir, `${name}.json`);

export async function store(dir: string, name: SeedCollection, docs: Snapshot): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(fileOf(dir, name), `${JSON.stringify(docs, null, 2)}\n`);
}

/** The stored snapshot, or undefined when none was downloaded. */
export async function load(dir: string, name: SeedCollection): Promise<Snapshot | undefined> {
  const file = fileOf(dir, name);
  return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
}
