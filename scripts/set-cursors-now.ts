import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Environment } from "../infra/lib/config";
import { resourceName } from "../infra/lib/naming";
import { createSourceRepo } from "../lib/db/sources";
import { parseTarget, REGION } from "../lib/ops/target";
import { SCRAPE_HEADERS } from "../lib/pipeline/scrape/index";
import { parseTelegramPage } from "../lib/telegram/parse";

/**
 * "Start scraping from now": point every live source's `lastItemId` at the
 * newest message its channel has right now.
 *
 * **Not a cursor reset.** Clearing `lastItemId` looks equivalent and is not:
 * §3.1 L205 would then fetch the bare `t.me/s/{id}` page, and since the cursor
 * is the sole duplicate-suppression mechanism (§3.1 L220) its whole newest
 * window — ~20 posts a channel — is enqueued as new. Writing the newest id
 * leaves that window *behind* the cursor, so only posts published after this
 * run are ever enqueued.
 *
 * What it is for: a cursor months behind resumes by replaying every post since,
 * which is correct for a cutover (`reseed-cursors.ts`, §9.5 L943) and wrong
 * after an outage nobody intends to backfill.
 *
 *   npm run cursors:now                    # dry run against dev
 *   npm run cursors:now -- --write
 *   npm run cursors:now -- --env=prod --write
 *
 * Dry run by default, like the other cutover scripts: `--write` is opt-in
 * because a cursor moved forward cannot be moved back — the posts it skipped
 * are gone from `t.me/s/`'s window and §1.3 L69 has no table to recover them.
 *
 * This one reads the channels directly rather than invoking the deployed
 * function, unlike `scrape.ts`: it is a repair of stored state, not a pipeline
 * run, and it must not enqueue anything.
 */

/** §7.2 L631's table, environment-prefixed per §9.2 L864. */
const SOURCES_RESOURCE = "sources";

const WRITE = "--write";

/** Telegram serves the preview page unauthenticated; this is a courtesy gap, not a documented limit. */
const PAUSE_MS = 150;

interface Advance {
  readonly id: string;
  readonly from: string | undefined;
  readonly to: string;
}

/**
 * Numeric, mirroring `newestItemId` in `lib/pipeline/scrape/index.ts`:
 * lexicographically `"9" > "10"`, which would drag a cursor backwards on any
 * channel crossing a digit boundary and re-publish everything between.
 */
function newestPostId(html: string): string | undefined {
  let newest: string | undefined;
  for (const post of parseTelegramPage(html)) {
    if (newest === undefined || Number(post.id) > Number(newest)) newest = post.id;
  }
  return newest;
}

async function fetchNewestId(id: string): Promise<string | undefined> {
  const response = await fetch(`https://t.me/s/${id}`, { headers: SCRAPE_HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return newestPostId(await response.text());
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const write = argv.includes(WRITE);
  // `parseTarget` rejects any argument it does not know, on purpose — so
  // `--write` is taken out before it, not added to it.
  const { env } = parseTarget(argv.filter((arg) => arg !== WRITE));

  const tableName = resourceName(env as Environment, SOURCES_RESOURCE);
  console.log(`${tableName} in ${REGION} — ${write ? "WRITE" : "dry run"}`);

  const repo = createSourceRepo({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
    tableName,
  });

  // R16's soft-deleted rows are excluded: scrape never polls them, so their
  // cursors do not matter and a fetch each is a request for nothing.
  const sources = (await repo.listAll()).filter((source) => source.deleted !== true);

  const advances: Advance[] = [];
  const skipped: string[] = [];

  for (const source of sources) {
    let newest: string | undefined;
    try {
      newest = await fetchNewestId(source.id);
    } catch (error) {
      // Left alone rather than guessed at: a cursor written from a failed read
      // would skip real posts.
      skipped.push(`${source.id}: fetch failed (${message(error)})`);
      continue;
    }

    if (newest === undefined) {
      // An unreachable or renamed channel parses empty exactly as a quiet one
      // does, so this is reported, never acted on. §4.1 L376's `SourceStale`
      // is what distinguishes them, over runs.
      skipped.push(`${source.id}: no posts on the page`);
      continue;
    }

    const from = source.lastItemId;
    if (from !== undefined && Number(newest) <= Number(from)) {
      skipped.push(`${source.id}: cursor ${from} already at or ahead of ${newest}`);
      continue;
    }

    advances.push({ id: source.id, from, to: newest });
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  for (const advance of advances) {
    console.log(`  ${advance.id}: ${advance.from ?? "(none)"} -> ${advance.to}`);
  }
  for (const note of skipped) {
    console.log(`  ${note} — unchanged`);
  }

  if (write) {
    for (const advance of advances) {
      // A patch, not a put: §3.1 L226's `updateCursor` writes only the cursor,
      // so an operator's concurrent edit to `category` or `teaser` survives.
      await repo.updateCursor(advance.id, { lastItemId: advance.to });
    }
  }

  console.log(
    `\n${write ? "advanced" : "would advance"} ${advances.length} of ${sources.length} live source(s); ` +
      `${skipped.length} unchanged`,
  );
  if (!write) console.log(`dry run — pass ${WRITE} to apply`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main().catch((error: unknown) => {
  console.error(`\n${message(error)}\n`);
  process.exit(1);
});
