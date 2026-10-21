import { FieldValue } from "firebase-admin/firestore";
import type { MetricName, Metrics } from "tg-enums/metrics";
import { db } from "./app";

/**
 * Counters, one document per hour in `metrics`.
 *
 * A count lands as `{name}: +n`, and with `by` also as `{name}By.{by}: +n`, so
 * a total never needs the split summed back.
 */

const HOUR_MS = 3_600_000;

const metricsRef = db.collection("metrics");

const pending = new Map<string, number>();

export const metrics: Metrics = {
  count(name, value = 1, by) {
    pending.set(name, (pending.get(name) ?? 0) + value);
    if (by !== undefined) {
      const key = `${name}By\u0000${by}`;
      pending.set(key, (pending.get(key) ?? 0) + value);
    }
  },
};

/** Writes what `count` collected. Called once at the end of every function run. */
export async function flushMetrics(now = Date.now()): Promise<void> {
  if (pending.size === 0) return;
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const fields: Record<string, unknown> = { hour };
  for (const [key, value] of pending) {
    const [name = "", by] = key.split("\u0000");
    if (by === undefined) {
      fields[name] = FieldValue.increment(value);
    } else {
      const split = (fields[name] ?? {}) as Record<string, unknown>;
      fields[name] = { ...split, [by]: FieldValue.increment(value) };
    }
  }
  pending.clear();
  await metricsRef.doc(new Date(hour).toISOString()).set(fields, { merge: true });
}

/** The hourly documents that overlap `[startMs, endMs)`. */
async function hours(startMs: number, endMs: number) {
  const from = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  const snap = await metricsRef.where("hour", ">=", from).where("hour", "<", endMs).get();
  return snap.docs.map((d) => d.data());
}

/** The total of one counter over the window. */
export async function sumMetric(name: MetricName, startMs: number, endMs: number) {
  let total = 0;
  for (const doc of await hours(startMs, endMs)) total += Number(doc[name] ?? 0);
  return total;
}

/** One counter's split over the window, keyed by its `by` value. */
export async function sumMetricBy(name: MetricName, startMs: number, endMs: number) {
  const totals: Record<string, number> = {};
  for (const doc of await hours(startMs, endMs)) {
    for (const [by, value] of Object.entries(doc[`${name}By`] ?? {})) {
      totals[by] = (totals[by] ?? 0) + Number(value);
    }
  }
  return totals;
}
