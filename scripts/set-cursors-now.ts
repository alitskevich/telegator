import { spawnSync } from "node:child_process";
import { PROJECT_ID } from "tg-configs/firebase";
import { sourceType } from "tg-domain/source";
import { sources } from "tg-firebase/db";
import { connectMtproto } from "tg-mtproto/client";
import { parseMtprotoCredentials } from "tg-mtproto/credentials";
import { createMtprotoReader } from "tg-mtproto/reader";

/**
 * "Start scraping from now": points every live Telegram source's `lastItemId`
 * at the newest post its chat has right now, so an outage is not backfilled.
 *
 * Not a cursor reset: an empty cursor reads the chat's whole newest page again.
 * Dry run unless `--write`; a cursor moved forward cannot move back. Reads
 * through the account in the `MTPROTO_SESSION` function secret.
 *
 *   npm run cursors:now                # dry run
 *   npm run cursors:now -- --write
 *
 * Firestore is the emulator when FIRESTORE_EMULATOR_HOST is set, else production.
 */

const PAUSE_MS = 150;

function mtprotoSession(): string {
  const access = spawnSync(
    "firebase",
    ["functions:secrets:access", "MTPROTO_SESSION", "-P", PROJECT_ID],
    { encoding: "utf8" },
  );
  if (access.status !== 0) throw new Error(`MTPROTO_SESSION not read: ${access.stderr}`);
  return access.stdout.trim();
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  console.log(
    `firestore=${process.env.FIRESTORE_EMULATOR_HOST ?? "production"} ${write ? "WRITE" : "dry run"}`,
  );

  const live = (await sources.listAll()).filter((source) => sourceType(source) === "telegram");
  const client = await connectMtproto(parseMtprotoCredentials(mtprotoSession()));
  const reader = createMtprotoReader(client);
  let advanced = 0;
  try {
    for (const source of live) {
      try {
        let newest: string | undefined;
        for (const post of await reader.read(source.id, undefined)) {
          if (newest === undefined || Number(post.id) > Number(newest)) newest = post.id;
        }
        const from = source.lastItemId;
        if (newest === undefined || (from && Number(newest) <= Number(from))) {
          console.log(`  ${source.id}: unchanged`);
          continue;
        }
        console.log(`  ${source.id}: ${from || "(none)"} -> ${newest}`);
        if (write) await sources.updateCursor(source.id, { lastItemId: newest });
        advanced += 1;
      } catch (error) {
        console.log(`  ${source.id}: read failed (${String(error)})`);
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  } finally {
    await client.destroy();
  }

  console.log(`\n${write ? "advanced" : "would advance"} ${advanced} of ${live.length} source(s)`);
}

await main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
