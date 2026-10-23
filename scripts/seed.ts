import { join } from "node:path";

/**
 * Snapshots of the operator-curated collections (`tg-seed`), one JSON file per
 * collection in `packages/tg-seed/data/<env>/` (git-ignored).
 *
 *   npm run seed:download -- dev|prod
 *   npm run seed:upload -- dev|prod [--write]   # dry run unless --write
 *
 * `dev` is the emulator `npm run dev` holds; `prod` is production through
 * `gcloud auth application-default login`. An upload replaces each collection:
 * documents missing from its file are deleted; a collection with no file is skipped.
 * `npm run dev` uploads the dev snapshot once the emulators are ready.
 */

const DEV_FIRESTORE_HOST = "127.0.0.1:8180";
const USAGE = "usage: tsx scripts/seed.ts download|upload dev|prod [--write]";

async function main(): Promise<void> {
  const [command, env] = process.argv.slice(2);
  const write = process.argv.includes("--write");
  if (command !== "download" && command !== "upload") throw new Error(USAGE);
  if (env !== "dev" && env !== "prod") throw new Error(USAGE);

  // Set before `tg-firebase` loads: the Admin SDK reads it once, at start.
  if (env === "dev") process.env.FIRESTORE_EMULATOR_HOST = DEV_FIRESTORE_HOST;
  else delete process.env.FIRESTORE_EMULATOR_HOST;
  const { SEED_COLLECTIONS, download, load, store, upload } = await import("tg-seed/seed");

  const dir = join(import.meta.dirname, "../packages/tg-seed/data", env);
  console.log(`${command} ${env} (${process.env.FIRESTORE_EMULATOR_HOST ?? "production"})`);

  for (const name of SEED_COLLECTIONS) {
    if (command === "download") {
      const docs = await download(name);
      await store(dir, name, docs);
      console.log(`${name}: ${Object.keys(docs).length} downloaded`);
    } else {
      const docs = await load(dir, name);
      if (docs === undefined) {
        console.log(`${name}: no snapshot, skipped`);
        continue;
      }
      const { written, deleted } = await upload(name, docs, write);
      console.log(`${name}: ${written} to write, ${deleted} to delete`);
    }
  }
  if (command === "upload") console.log(write ? "written" : "dry run — pass --write to apply");
}

await main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
