import type { Source } from "../domain/source";

/**
 * §9.4 L820-822 — "Because the schema changed, seeding is a **migration**, not a
 * copy."
 *
 * `sources` only: R20 records that §12.6 L888's "skip the import entirely" wins
 * over §9.4's messages row, and that the messages transform is unimplementable
 * anyway — the export carries one flat `summary`/`links` per message, so a
 * per-member `MemberBlock` (§2.3 L157-162) cannot be reconstructed for any
 * multi-member record.
 *
 * A pure transform. R21 keeps the export outside this repository, so the tests
 * run against inline fixtures and the write goes through the repository port.
 */

/** §2.1 L102-106's operator fields, plus the scrape cursor. Everything else is dropped. */
const TEXT_FIELDS = [
  "tgChannel",
  "category",
  "tags",
  "teaser",
  "lastItemId",
  "lastResult",
] as const;

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  // Absent rather than empty: `SourceSchema` marks these optional, and an empty
  // string would render as a blank cell that looks like a value someone set.
  return undefined;
}

/**
 * The export writes every field as a string. `lastCount` drives §3.1 L190's
 * refresh heuristic, which compares it numerically, so leaving it a string
 * would compare `"120" > 20` as false and pin every source to the slowest
 * poll rate — with nothing to see in the record.
 */
function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toSeedSource(row: unknown): Source {
  if (typeof row !== "object" || row === null) throw new Error("expected a source object");

  const source = row as Record<string, unknown>;
  const id = source.id;
  if (typeof id !== "string" || id === "") throw new Error("source row has no string id");

  const lastCount = count(source.lastCount);

  const seeded: Record<string, unknown> = {
    id,
    lastCount,
    lastUpdated: count(source.lastUpdated),
    /**
     * R15's addition, so the export has none. `lastCount` is the closest true
     * statement available: the last poll's count was, at the time, the last
     * non-zero one if it was non-zero at all.
     */
    lastNonZeroCount: lastCount,
  };

  /**
   * An empty string cannot be a GSI partition key — DynamoDB rejects the write.
   * Omitting the attribute leaves the record out of the sparse `status-index`,
   * which is precisely what §2.1 L102 means by "any value other than `ok`
   * disables the source".
   */
  const status = text(source.status);
  if (status !== undefined) seeded.status = status;

  for (const field of TEXT_FIELDS) {
    const value = text(source[field]);
    if (value !== undefined) seeded[field] = value;
  }

  /**
   * `zeroYieldRuns` is deliberately absent. §2.4 gives it a read-side default of
   * 0, so writing it would store the same value with an extra attribute, and
   * §4.1 L373's staleness alarm reads the default identically.
   */
  return seeded as Source;
}

/**
 * The export is an object keyed by table name — `{ "sources": [...] }` — not the
 * bare array this module was first written against. A bare array is still
 * accepted, because that is what every fixture and every caller that slices the
 * file itself already passes.
 */
function rowsOf(exported: unknown): unknown[] {
  if (Array.isArray(exported)) return exported;

  if (typeof exported === "object" && exported !== null) {
    const { sources } = exported as { sources?: unknown };
    if (Array.isArray(sources)) return sources;
  }

  throw new Error("data-sources.json must contain an array, or a sources array");
}

export function seedSourcesFrom(exported: unknown): Source[] {
  return rowsOf(exported).map((row, index) => {
    try {
      return toSeedSource(row);
    } catch (error) {
      // The file has no other way to point at a row, and a migration that fails
      // without saying where leaves an operator diffing JSON by eye.
      throw new Error(`row ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
