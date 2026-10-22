import type { Source } from "tg-domain/source";
import { SOURCE_STATUS_OK, sourceType } from "tg-domain/source";
import type { SourceType } from "tg-enums/sourceType";

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

/** When this source is next due to be polled: hot at once; warm after 30 min; cold after 240. */
export function dueAt(source: Source): number {
  if (source.lastCount > HOT_THRESHOLD_COUNT) return source.lastUpdated;
  return source.lastUpdated + (source.lastCount > 0 ? WARM_INTERVAL_MS : COLD_INTERVAL_MS);
}

/**
 * The sources this run should poll: enabled, not deleted, of this reader's
 * `type`, and due. Status is checked again so any input list is safe.
 *
 * Each transport has its own schedule; a source read by both would be enqueued
 * twice and have its one cursor moved by two readers.
 */
export function selectSources(sources: readonly Source[], now: number, type: SourceType): Source[] {
  return (
    sources
      .filter((source) => source.status === SOURCE_STATUS_OK && source.deleted !== true)
      .filter((source) => sourceType(source) === type)
      .filter((source) => dueAt(source) <= now)
      // Most overdue first, so fresher sources cannot starve one.
      .sort((a, b) => a.lastUpdated - b.lastUpdated)
      .slice(0, MAX_SOURCES_PER_RUN)
  );
}
