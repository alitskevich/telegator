import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ENV_VARS } from "../handlers/env.js";
import { createSourceRepo } from "../lib/db/sources.js";
import { parseReseedArgs } from "../lib/seed/args.js";
import { parseCursorFile, planCursorReseed } from "../lib/seed/cursors.js";

/**
 * §9.5 step 5 (L831) — re-seed `lastItemId` so AWS resumes where Firebase
 * stopped rather than re-scraping.
 *
 * **The cursors must be the values Firebase stopped at.** If the Firebase
 * Telegram schedulers are still running when this is taken, they keep advancing
 * their own cursors underneath, so step 6 (L832) enables the AWS schedule
 * against a stale value and re-scrapes the gap — which is L834's double-post.
 * §9.5 no longer carries a step for stopping them, and nothing here can verify
 * that they have stopped, so the script says so and refuses any cursor that
 * would move backwards.
 *
 * Everything worth testing is in `lib/seed/cursors.ts`.
 */

async function main(): Promise<void> {
  const { cursorsFile, write } = parseReseedArgs(process.argv.slice(2));

  const cursors = parseCursorFile(JSON.parse(readFileSync(cursorsFile, "utf8")));

  const repo = createSourceRepo({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tableName: requireEnv(ENV_VARS.sourcesTable),
  });

  const plan = planCursorReseed(await repo.listAll(), cursors);

  for (const update of plan.updates) {
    console.log(`  ${update.id}: ${update.from ?? "(none)"} -> ${update.lastItemId}`);
  }

  for (const id of plan.unknown) {
    console.warn(`  ${id}: no such source — check the id, or the source was deleted`);
  }

  for (const conflict of plan.backwards) {
    console.error(
      `  ${conflict.id}: REFUSED, ${conflict.lastItemId} is behind ${conflict.from} — ` +
        "re-scraping would re-publish (§9.5 L834)",
    );
  }

  if (plan.backwards.length > 0) {
    // A cutover with one wrong cursor is worse than a cutover that stopped: the
    // wrong one double-posts to real subscribers.
    throw new Error(`${plan.backwards.length} cursor(s) would move backwards; nothing written`);
  }

  if (!write) {
    console.log(
      "dry run — pass --write to apply. Confirm the Firebase Telegram schedulers are " +
        "stopped first: these cursors must be the values they stopped at (§9.5 L834).",
    );
    return;
  }

  for (const update of plan.updates) {
    // A patch, not a put: §3.1 L216's `updateCursor` writes only the cursor, so
    // an operator's concurrent edit to `category` or `teaser` survives.
    await repo.updateCursor(update.id, { lastItemId: update.lastItemId });
  }

  console.log(`reseeded ${plan.updates.length} cursor(s)`);
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
