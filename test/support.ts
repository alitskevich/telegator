import type { AdjudicationPair, Adjudicator, Classifier } from "tg-ai/types";
import type { MemberMerge } from "tg-dedup/types";
import { type DedupCandidate, DedupCandidateSchema, type Message } from "tg-domain/message";
import type { NewsItem } from "tg-domain/newsItemSchema";
import type { MetricName } from "tg-enums/metrics";
import type { Metrics } from "tg-enums/types";
import type { Clock, LogSink } from "tg-utils/types";

/** Test helpers. No test touches the network; Firestore is the emulator `npm test` starts. */

export const fixedClock = (instant: number): Clock => ({ now: () => instant });

export function advancingClock(start: number, stepMs = 1): Clock {
  let next = start;
  return {
    now: () => {
      const current = next;
      next += stepMs;
      return current;
    },
  };
}

export function recordingSink(): LogSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

export function recordingMetrics(): Metrics & {
  get(name: MetricName, by?: string): number;
} {
  const records: { name: MetricName; value: number; by?: string | undefined }[] = [];
  return {
    count: (name, value = 1, by) => void records.push({ name, value, by }),
    get: (name, by) =>
      records
        .filter((r) => r.name === name && (by === undefined || r.by === by))
        .reduce((sum, r) => sum + r.value, 0),
  };
}

export function stubClassifier(results: Readonly<Record<string, NewsItem>>): Classifier & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    classify: async (body) => {
      calls.push(body);
      const result = results[body];
      if (result === undefined) throw new Error(`no script for body: ${body}`);
      return result;
    },
  };
}

export function fakeAdjudicator(
  decide: (pair: AdjudicationPair) => boolean,
): Adjudicator & { readonly calls: AdjudicationPair[][] } {
  const calls: AdjudicationPair[][] = [];
  return {
    calls,
    adjudicate: async (pairs) => {
      calls.push([...pairs]);
      return new Map(pairs.map((pair) => [pair.id, decide(pair)]));
    },
  };
}

export const failingAdjudicator = (message = "adjudicator unavailable"): Adjudicator => ({
  adjudicate: async () => {
    throw new Error(message);
  },
});

/** An in-memory `messages` for the pure dedup tests: the loaders and the two writes. */
export function memoryMessages(initial: readonly Message[] = []) {
  const rows = new Map(initial.map((m) => [m.id, structuredClone(m)]));
  let writeCount = 0;
  return {
    get writeCount() {
      return writeCount;
    },
    get: async (id: string) => structuredClone(rows.get(id)),
    queryByDate: async (date: string): Promise<DedupCandidate[]> =>
      [...rows.values()]
        .filter((m) => m.date === date && m.deleted !== true)
        .map((m) => DedupCandidateSchema.parse(m)),
    putNew: async (message: Message) => {
      if (rows.has(message.id)) throw new Error(`message ${message.id} already exists`);
      writeCount++;
      rows.set(message.id, structuredClone(message));
    },
    mergeMember: async ({ id, members, attributes }: MemberMerge) => {
      const existing = rows.get(id);
      if (existing === undefined) throw new Error(`no such message: ${id}`);
      writeCount++;
      rows.set(id, { ...existing, ...attributes, members: { ...existing.members, ...members } });
    },
  };
}

/** Empties the Firestore emulator between tests. */
export async function clearFirestore(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.GCLOUD_PROJECT;
  if (host === undefined || project === undefined) {
    throw new Error("no Firestore emulator: run the tests with `npm test`");
  }
  const url = `http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) throw new Error(`clearing Firestore failed: ${response.status}`);
}
