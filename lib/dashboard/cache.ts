import type { CategoryLogReader, MetricReader, TimeWindow } from "../aws/ports";
import type { Clock } from "../clock";
import type { MetricDimensionName, MetricName } from "../metrics/ports";

/**
 * §8.5 L774 — "All CloudWatch reads are cached 60 s ... so a refresh does not
 * re-query."
 *
 * Applied by decorating the ports rather than by wrapping each card, so the rule
 * holds for every read including ones added later. The spec names Next's
 * `unstable_cache`; this is deliberately not that — see R35. A page may still
 * wrap these in `unstable_cache` for a cache shared across instances; the TTL
 * here is what makes the rule true inside one.
 */
export const CACHE_TTL_MS = 60_000;

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function memoize<T>(clock: Clock, ttlMs: number) {
  const entries = new Map<string, Entry<T>>();

  return async (key: string, compute: () => Promise<T>): Promise<T> => {
    const now = clock.now();
    const cached = entries.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.value;

    // Awaited before storing, so a rejection is never cached: a throttled call at
    // page load would otherwise blank every card for the next minute.
    const value = await compute();
    entries.set(key, { value, expiresAt: now + ttlMs });
    return value;
  };
}

const windowKey = (window: TimeWindow) => `${window.startMs}-${window.endMs}`;

export function cachedMetricReader(
  inner: MetricReader,
  clock: Clock,
  ttlMs: number = CACHE_TTL_MS,
): MetricReader {
  const totals = memoize<number>(clock, ttlMs);
  const dimensioned = memoize<Record<string, number>>(clock, ttlMs);

  return {
    // Keyed by metric and window: a 24 h card and a 7 d card over the same
    // counter are different questions with different answers.
    sum: (name: MetricName, window) =>
      totals(`${name}|${windowKey(window)}`, () => inner.sum(name, window)),

    sumByDimension: (name: MetricName, dimension: MetricDimensionName, values, window) =>
      dimensioned(`${name}|${dimension}|${values.join(",")}|${windowKey(window)}`, () =>
        inner.sumByDimension(name, dimension, values, window),
      ),
  };
}

export function cachedCategoryLogReader(
  inner: CategoryLogReader,
  clock: Clock,
  ttlMs: number = CACHE_TTL_MS,
): CategoryLogReader {
  const rows = memoize<Awaited<ReturnType<CategoryLogReader["countByCategory"]>>>(clock, ttlMs);

  return {
    countByCategory: (window) => rows(windowKey(window), () => inner.countByCategory(window)),
  };
}
