import { sources } from "tg-firebase/db";
import { SCRAPE_HEADERS } from "tg-pipeline/scrape/index";
import { parseTelegramPage } from "tg-telegram/parse";

/**
 * "Start scraping from now": points every live source's `lastItemId` at the
 * newest post its channel has right now, so an outage is not backfilled.
 *
 * Not a cursor reset: an empty cursor fetches the channel's whole newest
 * window again. Dry run unless `--write`; a cursor moved forward cannot move back.
 *
 *   npm run cursors:now                # dry run
 *   npm run cursors:now -- --write
 *
 * Firestore is the emulator when FIRESTORE_EMULATOR_HOST is set, else production.
 */

const PAUSE_MS = 150;

async function newestPostId(channel: string): Promise<string | undefined> {
  const response = await fetch(`https://t.me/s/${channel}`, { headers: SCRAPE_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let newest: string | undefined;
  for (const post of parseTelegramPage(await response.text())) {
    if (newest === undefined || Number(post.id) > Number(newest)) newest = post.id;
  }
  return newest;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  console.log(
    `firestore=${process.env.FIRESTORE_EMULATOR_HOST ?? "production"} ${write ? "WRITE" : "dry run"}`,
  );

  const live = await sources.listAll();
  let advanced = 0;
  for (const source of live) {
    try {
      const newest = await newestPostId(source.id);
      const from = source.lastItemId;
      if (newest === undefined || (from && Number(newest) <= Number(from))) {
        console.log(`  ${source.id}: unchanged`);
        continue;
      }
      console.log(`  ${source.id}: ${from || "(none)"} -> ${newest}`);
      if (write) await sources.updateCursor(source.id, { lastItemId: newest });
      advanced += 1;
    } catch (error) {
      console.log(`  ${source.id}: fetch failed (${String(error)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  console.log(`\n${write ? "advanced" : "would advance"} ${advanced} of ${live.length} source(s)`);
}

await main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
