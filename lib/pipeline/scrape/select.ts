import type { Source } from "../../domain/source.js";
import { SOURCE_STATUS_OK } from "../../domain/source.js";

/** One minute in milliseconds — the unit §3.1 L190 writes as `* 60_000`. */
const MINUTE_MS = 60_000;

/**
 * §3.1 L193: "a **hot** source (>20 posts last run) is always eligible". The
 * comparison is strictly greater, so 20 is the top of the warm band (L193's
 * "warm source (1–20)") and 21 is the bottom of the hot band.
 */
export const HOT_THRESHOLD_COUNT = 20;

/** §3.1 L190/L193 — a warm source (`lastCount` 1–20) is due after 30 minutes. */
export const WARM_INTERVAL_MINUTES = 30;
export const WARM_INTERVAL_MS = WARM_INTERVAL_MINUTES * MINUTE_MS;

/** §3.1 L190/L193 — a cold source (`lastCount === 0`) backs off to 240 minutes. */
export const COLD_INTERVAL_MINUTES = 240;
export const COLD_INTERVAL_MS = COLD_INTERVAL_MINUTES * MINUTE_MS;

/** §3.1 L193: "Take the first **10**." The scraper's per-run fan-out budget. */
export const MAX_SOURCES_PER_RUN = 10;

/**
 * Is this source due to be polled?
 *
 * **R14.** §3.1 L190's formula is only two-tier:
 *
 * ```
 * now - lastUpdated >= (lastCount > 0 ? 30 : 240) * 60_000
 * ```
 *
 * It puts a hot source in the same 30-minute bucket as a warm one, which
 * contradicts L193's "a **hot** source (>20 posts last run) is always eligible"
 * and fails AC-1.2 (L221, "A source with `lastCount = 25` is selected regardless
 * of `lastUpdated`") for any hot source polled less than 30 minutes ago. The
 * prose and the acceptance criterion agree with each other against the formula,
 * so the formula is the defect: the hot tier is restored as a leading disjunct
 * and L190's expression is kept verbatim for the warm/cold tiers below it.
 */
function isDue(source: Source, now: number): boolean {
  return (
    source.lastCount > HOT_THRESHOLD_COUNT ||
    now - source.lastUpdated >= (source.lastCount > 0 ? WARM_INTERVAL_MS : COLD_INTERVAL_MS)
  );
}

/**
 * §3.1 L187–193 — the sources this run should poll.
 *
 * `sources` stands in for the `status-index` query of L187; the status check is
 * repeated here so the function is correct on any input, including the unfiltered
 * scans the tests and the operator tooling hand it.
 *
 * **R16.** §8.4 L751's `deleteRecords` is a soft delete that sets `deleted: true`,
 * and §3.1 never filters on it — a deleted source would keep being polled and keep
 * publishing, since nothing else in the pipeline consults the flag.
 */
export function selectSources(sources: readonly Source[], now: number): Source[] {
  return (
    sources
      .filter((source) => source.status === SOURCE_STATUS_OK && source.deleted !== true)
      .filter((source) => isDue(source, now))
      // L193 says "the first 10" without saying first by what. Recorded decision,
      // not spec text: oldest `lastUpdated` first, so the most overdue sources take
      // the slots and no source can be starved by a crowd of fresher ones.
      .sort((a, b) => a.lastUpdated - b.lastUpdated)
      .slice(0, MAX_SOURCES_PER_RUN)
  );
}
