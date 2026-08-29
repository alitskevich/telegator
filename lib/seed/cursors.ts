import type { Source } from "../domain/source.js";

/**
 * §9.5 step 6 (L832) — "Re-seed source cursors (`lastItemId`) from the live
 * Firebase values, so AWS resumes where Firebase stopped rather than
 * re-scraping."
 *
 * Ordering is load-bearing and this script cannot check it: step 6 must run
 * *after* step 5 disables the Firebase Telegram schedulers (L831). Run earlier
 * and Firebase advances its own cursors underneath this, so step 7 enables AWS
 * against a stale value and re-scrapes the gap — which is L836's double-post.
 *
 * The spec names no source for the live values, so they arrive as a JSON map.
 */

/** §3.1 L201 captures the id from `href="https://t.me/{any}/{digits}"`. */
const TELEGRAM_MESSAGE_ID = /^\d+$/;

export type CursorMap = Readonly<Record<string, string>>;

export function parseCursorFile(raw: unknown): CursorMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("the cursor file must contain an object of {sourceId: lastItemId}");
  }

  const cursors: Record<string, string> = {};

  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !TELEGRAM_MESSAGE_ID.test(value)) {
      // Named, because a cursor that is not a message id would be written
      // verbatim into `?after=` and Telegram would answer with the whole channel.
      throw new Error(`${id}: cursor must be a string of digits, got ${JSON.stringify(value)}`);
    }
    cursors[id] = value;
  }

  return cursors;
}

export interface CursorUpdate {
  readonly id: string;
  /** What the source carries now — `undefined` for one that has never polled. */
  readonly from: string | undefined;
  readonly lastItemId: string;
}

export interface CursorPlan {
  readonly updates: CursorUpdate[];
  /** Ids in the file that match no live source: a typo, or a deleted source. */
  readonly unknown: string[];
  /** Cursors that would move backwards. Refused — see below. */
  readonly backwards: CursorUpdate[];
}

/**
 * Work out what to write, without writing it.
 *
 * A backwards move is refused rather than applied. §9.5 L836 is the invariant of
 * the whole cutover — "The two systems must never publish the same Telegram
 * content concurrently — they would double-post" — and moving a cursor back
 * makes AWS re-scrape posts it has already published, which is that failure
 * exactly. Refusing puts the conflict in front of an operator who can still fix
 * the file, rather than in the channel where subscribers see it.
 */
export function planCursorReseed(sources: readonly Source[], cursors: CursorMap): CursorPlan {
  // R16 — a soft-deleted source is not a source. Reseeding one would resurrect
  // a cursor for a channel nobody polls.
  const live = new Map(sources.filter((source) => source.deleted !== true).map((s) => [s.id, s]));

  const updates: CursorUpdate[] = [];
  const unknown: string[] = [];
  const backwards: CursorUpdate[] = [];

  for (const [id, lastItemId] of Object.entries(cursors)) {
    const source = live.get(id);
    if (source === undefined) {
      unknown.push(id);
      continue;
    }

    const from = source.lastItemId;
    const update = { id, from, lastItemId };

    if (from === undefined) {
      // No cursor at all is the case this step exists for: §3.1 L195 omits
      // `?after=` without one, so the first poll re-scrapes the whole visible
      // history of the channel.
      updates.push(update);
      continue;
    }

    // Numerically: "9" > "100" as text, but 100 is the later post.
    const current = Number(from);
    const next = Number(lastItemId);

    if (next < current) backwards.push(update);
    else if (next > current) updates.push(update);
  }

  return { updates, unknown, backwards };
}
