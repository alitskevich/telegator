import type { Source } from "tg-domain/source";
import { SOURCE_STATUS_OK, sourceVia } from "tg-domain/source";
import type { SourceVia } from "tg-enums/sourceVia";

const MINUTE_MS = 60_000;

/** A hot source (more than 20 posts last run) is always due; 20 is still warm. */
export const HOT_THRESHOLD_COUNT = 20;

/** A warm source (`lastCount` 1–20) is due after 30 minutes. */
export const WARM_INTERVAL_MINUTES = 30;
export const WARM_INTERVAL_MS = WARM_INTERVAL_MINUTES * MINUTE_MS;

/** A cold source (`lastCount === 0`) backs off to 240 minutes. */
export const COLD_INTERVAL_MINUTES = 240;
export const COLD_INTERVAL_MS = COLD_INTERVAL_MINUTES * MINUTE_MS;

/** At most this many sources per run. */
export const MAX_SOURCES_PER_RUN = 10;

/** Is this source due to be polled? Hot always; warm after 30 min; cold after 240. */
function isDue(source: Source, now: number): boolean {
  return (
    source.lastCount > HOT_THRESHOLD_COUNT ||
    now - source.lastUpdated >= (source.lastCount > 0 ? WARM_INTERVAL_MS : COLD_INTERVAL_MS)
  );
}

/**
 * The sources this run should poll: enabled, not deleted, of this reader's
 * `via`, and due. Status is checked again so any input list is safe.
 *
 * Each transport has its own schedule; a source read by both would be enqueued
 * twice and have its one cursor moved by two readers.
 */
export function selectSources(sources: readonly Source[], now: number, via: SourceVia): Source[] {
  return (
    sources
      .filter((source) => source.status === SOURCE_STATUS_OK && source.deleted !== true)
      .filter((source) => sourceVia(source) === via)
      .filter((source) => isDue(source, now))
      // Most overdue first, so fresher sources cannot starve one.
      .sort((a, b) => a.lastUpdated - b.lastUpdated)
      .slice(0, MAX_SOURCES_PER_RUN)
  );
}
