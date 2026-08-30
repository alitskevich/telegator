import { beforeEach, describe, expect, test } from "vitest";
import { failingAdjudicator, fakeAdjudicator } from "../../test/fakes/ai";
import { advancingClock, fixedClock } from "../../test/fakes/clock";
import { fakeMessageRepo } from "../../test/fakes/db";
import { recordingSink } from "../../test/fakes/logging";
import { recordingMetrics } from "../../test/fakes/metrics";
import type { Adjudicator } from "../ai/ports";
import { type AnalyzedItem, AnalyzedItemSchema } from "../domain/item";
import { type MemberBlock, type Message, MessageSchema } from "../domain/message";
import { createLogger } from "../logging/logger";
import { DISTINCT_THRESHOLD, MAX_MEMBERS, MERGE_THRESHOLD } from "./constants";
import { type DedupDeps, dedupBatch } from "./dedupBatch";
import { buildMatchKey, type MatchKeyFields, matchKeyAttributes } from "./matchKey";
import { matchScore } from "./score";

const DATE = "2026-08-29";

/**
 * Two reports of one event.
 *
 * Identical entities and tags put any pair built from this at 0.75 before the
 * titles contribute anything — above `MERGE_THRESHOLD` whatever they are — so a
 * test that varies a descriptive field is varying that field and not the
 * verdict.
 */
const SAME_EVENT = {
  title: "Minsk Factory Fire",
  properNames: "Minsk, Belaruskali",
  tags: "fire,safety",
} as const;

/** Disjoint from `SAME_EVENT` in all three components, so the pair scores 0. */
const OTHER_EVENT = {
  title: "Brest Border Queue",
  properNames: "Brest",
  tags: "transport",
} as const;

function item(id: string, overrides: Partial<AnalyzedItem> = {}): AnalyzedItem {
  return AnalyzedItemSchema.parse({
    id,
    body: `body of ${id}`,
    links: [],
    date: DATE,
    kind: "post",
    title: `title ${id}`,
    summary: `summary ${id}`,
    country: "UA",
    location: "Kyiv",
    category: "geopolitics",
    importance: "high",
    ...overrides,
  });
}

/** The three stored projections a record carrying `fields`' key would have (R44). */
const keyOf = (fields: MatchKeyFields) => matchKeyAttributes(buildMatchKey(fields));

function storedMessage(over: Partial<Message> & Pick<Message, "id">): Message {
  const members: Record<string, MemberBlock> = over.members ?? {
    [over.id]: { summary: "stored", links: [], channel: over.id.split("/")[0] ?? "c", ts: 1 },
  };
  // Parsed rather than cast, so a fixture that violates §2.3 L145's memberCount
  // invariant fails in the test that built it rather than somewhere downstream.
  return MessageSchema.parse({
    status: "topublish",
    date: DATE,
    tgChannel: "telegator_news",
    ts: 1,
    // R51 — `toWrite` derives `memberIds` from `members`, so a fixture that set
    // the two independently could pass a test the real writer would fail. A
    // caller that wants them out of step says so explicitly.
    memberIds: Object.keys(members),
    ...over,
    members,
    memberCount: Object.keys(members).length,
  });
}

/**
 * A stored message whose single member — and whose match key — are exactly what
 * `source` would have produced, so re-processing it is a true replay: R51's
 * short-circuit finds it by `memberIds` and R11 preserves the block's `ts`.
 */
function replayable(source: AnalyzedItem, over: Partial<Message> = {}): Message {
  return storedMessage({
    id: source.id,
    ...keyOf(source),
    title: source.title,
    category: source.category,
    country: source.country,
    location: source.location,
    tags: source.tags ?? "",
    members: {
      [source.id]: {
        summary: source.summary,
        links: source.links,
        channel: source.id.split("/")[0] ?? "c",
        ts: 1,
      },
    },
    ...over,
  });
}

let metrics: ReturnType<typeof recordingMetrics>;
let sink: ReturnType<typeof recordingSink>;

beforeEach(() => {
  metrics = recordingMetrics();
  sink = recordingSink();
});

function deps(over: Partial<DedupDeps> = {}): DedupDeps {
  const repo = fakeMessageRepo([]);
  return {
    // Refuses every band pair by default, so no test can merge through the
    // model without saying that is what it is testing.
    adjudicator: fakeAdjudicator(() => false),
    loadCandidatesByDate: repo.queryByDate,
    loadMessage: repo.get,
    clock: fixedClock(1000),
    metrics,
    logger: createLogger(sink),
    ...over,
  };
}

/**
 * Wraps `loadMessage` to count base-table reads.
 *
 * R46 puts a read on the band path and only there, so "how many" is a claim
 * tests have to be able to make.
 */
function countingReads(over: Partial<DedupDeps> & Pick<DedupDeps, "loadMessage">) {
  const reads: string[] = [];
  return {
    reads,
    deps: {
      ...over,
      loadMessage: async (id: string) => {
        reads.push(id);
        return over.loadMessage(id);
      },
    },
  };
}

function repoDeps(stored: readonly Message[], over: Partial<DedupDeps> = {}) {
  const repo = fakeMessageRepo(stored);
  return {
    repo,
    deps: deps({ loadCandidatesByDate: repo.queryByDate, loadMessage: repo.get, ...over }),
  };
}

function scoreOf(a: MatchKeyFields, b: MatchKeyFields): number {
  return matchScore(buildMatchKey(a), buildMatchKey(b));
}

/** `items[i]` against `items[j]`, without the index gymnastics in every caller. */
function pairScore(items: readonly AnalyzedItem[], left: number, right: number): number {
  const a = items[left];
  const b = items[right];
  if (a === undefined || b === undefined) throw new Error("fixture is shorter than the test needs");
  return scoreOf(a, b);
}

// ---------------------------------------------------------------------------
// Band fixtures (R46). Each one's score is chosen against SCORE_WEIGHTS, not
// picked, and `the fixtures sit where the band tests assume` below is what
// stops a weight or threshold change turning a band test into a merge test that
// passes for the wrong reason.
// ---------------------------------------------------------------------------

/** Score 1: identical entities, title and tags. */
const twoNearIdenticalItems = () => [item("src_a/1", SAME_EVENT), item("src_b/2", SAME_EVENT)];

/** Score 0: no shared term in any component. */
const twoUnrelatedItems = () => [item("src_a/1", SAME_EVENT), item("src_b/2", OTHER_EVENT)];

/**
 * Mid-band, and the arithmetic is the point: entities share two of three
 * (0.6 x 2/3 = 0.400), titles one token of three (0.25 x 1/3 = 0.083) and tags
 * one of three (0.15 x 1/3 = 0.050) — 0.533, between `DISTINCT_THRESHOLD` and
 * `MERGE_THRESHOLD`.
 */
const AMBIGUOUS = [
  { title: "Alpha Beta", properNames: "Minsk, Belaruskali", tags: "fire,safety" },
  { title: "Alpha Gamma", properNames: "Minsk, Belaruskali, Naftan", tags: "fire,industry" },
  { title: "Alpha Delta", properNames: "Minsk, Belaruskali, Grodno", tags: "fire,transport" },
] as const;

const twoAmbiguousItems = () => [item("src_a/1", AMBIGUOUS[0]), item("src_b/2", AMBIGUOUS[1])];

/**
 * Both later items sit in the band against the first, and neither is resolved
 * before the other is scored — so the batch owes exactly two verdicts, and a
 * per-pair implementation would make two calls for them.
 */
const threeAmbiguousItems = () => [...twoAmbiguousItems(), item("src_c/3", AMBIGUOUS[2])];

/**
 * `src_c/3` sits in the band against **both** messages ahead of it — 0.533
 * against `src_a/1` and 0.433 against `src_b/2` — while those two score 0.150
 * against each other and stay apart. Only the higher of `src_c/3`'s two pairs
 * may ever reach the model.
 */
const oneItemTwoCandidates = () => [
  item("src_a/1", { title: "Alpha Beta", properNames: "Minsk, Belaruskali", tags: "fire,safety" }),
  item("src_b/2", {
    title: "Gamma Delta",
    properNames: "Brest, Naftan, Minsk",
    tags: "transport,border",
  }),
  item("src_c/3", {
    title: "Alpha Gamma",
    properNames: "Minsk, Belaruskali, Brest",
    tags: "fire,transport",
  }),
];

describe("the band fixtures", () => {
  /**
   * Guards the fixtures themselves. If a weight or a threshold moves, that fails
   * loudly here rather than silently turning every band test below into a merge
   * test — or a split test — that passes for the wrong reason.
   */
  test("the fixtures sit where the band tests assume", () => {
    expect(pairScore(twoNearIdenticalItems(), 0, 1)).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    expect(pairScore(twoUnrelatedItems(), 0, 1)).toBeLessThanOrEqual(DISTINCT_THRESHOLD);

    expect(pairScore(twoAmbiguousItems(), 0, 1)).toBeGreaterThan(DISTINCT_THRESHOLD);
    expect(pairScore(twoAmbiguousItems(), 0, 1)).toBeLessThan(MERGE_THRESHOLD);

    // The third item is in the band against the first, which is the only
    // candidate it can see while the second is still awaiting a verdict.
    expect(pairScore(threeAmbiguousItems(), 0, 2)).toBeGreaterThan(DISTINCT_THRESHOLD);
    expect(pairScore(threeAmbiguousItems(), 0, 2)).toBeLessThan(MERGE_THRESHOLD);
  });

  test("the two-candidate fixture really offers two, ranked", () => {
    const items = oneItemTwoCandidates();

    expect(pairScore(items, 0, 1)).toBeLessThanOrEqual(DISTINCT_THRESHOLD);

    for (const candidate of [0, 1]) {
      expect(pairScore(items, candidate, 2)).toBeGreaterThan(DISTINCT_THRESHOLD);
      expect(pairScore(items, candidate, 2)).toBeLessThan(MERGE_THRESHOLD);
    }
    expect(pairScore(items, 0, 2)).toBeGreaterThan(pairScore(items, 1, 2));
  });
});

describe("empty batch", () => {
  test("makes no model call, no query and no write", async () => {
    const adjudicator = fakeAdjudicator(() => true);
    const { repo, deps: d } = repoDeps([], { adjudicator });

    const result = await dedupBatch([], d);

    expect(result.writes).toEqual([]);
    expect(result.toPublish).toEqual([]);
    expect(adjudicator.calls).toEqual([]);
    expect(repo.writeCount).toBe(0);
  });
});

describe("create branch (§6 L538-541)", () => {
  test("a single item becomes one message keyed by its own id", async () => {
    const a = item("chan_a/1");
    const result = await dedupBatch([a], deps());

    expect(result.writes).toHaveLength(1);
    const write = result.writes[0];
    expect(write?.kind).toBe("create");
    if (write?.kind !== "create") throw new Error("expected a create");

    expect(write.message.id).toBe("chan_a/1");
    expect(Object.keys(write.message.members)).toEqual(["chan_a/1"]);
    expect(write.message.memberCount).toBe(1);
    expect(write.message.status).toBe("topublish");
    expect(write.message.tgId).toBeUndefined();
    expect(result.toPublish).toEqual(["chan_a/1"]);
  });

  test("the member block carries what publish needs to render it (§1.3 L48)", async () => {
    const a = item("chan_a/1", { summary: "Выбухі", links: [{ id: 1, href: "https://x.test" }] });
    const result = await dedupBatch([a], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.members["chan_a/1"]).toEqual({
      summary: "Выбухі",
      links: [{ id: 1, href: "https://x.test" }],
      channel: "chan_a",
      ts: 1000,
    });
  });

  test("defaults tgChannel to telegator_news, and keeps an explicit one", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", { ...OTHER_EVENT, tgChannel: "other_news" });
    const result = await dedupBatch([a, b], deps());

    const channels = result.writes.map((w) => (w.kind === "create" ? w.message.tgChannel : ""));
    expect(channels).toEqual(["telegator_news", "other_news"]);
  });

  /** R45 — the key the scorer will read back on the next batch (§7.2 L598). */
  test("stores the item's own match key, and no embedding", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const result = await dedupBatch([a], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.keyEntities).toEqual(["belaruskali", "minsk"]);
    expect(write.message.keyTitle).toEqual(["factory", "fire", "minsk"]);
    expect(write.message.keyTags).toEqual(["fire", "safety"]);
    expect(write.message).not.toHaveProperty("embedding");
  });

  /** R51 — projected so the replay short-circuit costs no base-table read. */
  test("stores memberIds alongside the members they are derived from", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
    const result = await dedupBatch([a, b], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.memberIds).toEqual(Object.keys(write.message.members));
    expect(write.message.memberIds).toEqual(["chan_a/1", "chan_b/2"]);
  });

  test("R7: item-only fields never reach the record", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const result = await dedupBatch([a], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    for (const key of ["body", "kind", "importance", "properNames", "links"]) {
      expect(write.message).not.toHaveProperty(key);
    }
  });

  test("R8: every created record carries ts, the sort key on both GSIs", async () => {
    const a = item("chan_a/1");
    const result = await dedupBatch([a], deps({ clock: fixedClock(9999) }));

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.ts).toBe(9999);
  });
});

describe("Pass 1 — intra-batch matching (§6 L505-511)", () => {
  /**
   * AC-3.1 (L300), R47 — "cosine similarity 0.90" restated as a score at or
   * above `MERGE_THRESHOLD`; the id is kept, the vocabulary is not.
   */
  test("two near-identical items on the same date produce one message with two members", async () => {
    const result = await dedupBatch(twoNearIdenticalItems(), deps());

    expect(result.writes).toHaveLength(1);
    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(Object.keys(write.message.members).sort()).toEqual(["src_a/1", "src_b/2"]);
    expect(write.message.memberCount).toBe(2);
    expect(write.message.id).toBe("src_a/1");
  });

  /**
   * AC-3.3 (L302), R47 — "0.80" restated as a score at or below
   * `DISTINCT_THRESHOLD`; the id is kept, the vocabulary is not.
   */
  test("two unrelated items produce two messages", async () => {
    const result = await dedupBatch(twoUnrelatedItems(), deps());

    expect(result.writes).toHaveLength(2);
    expect([...result.toPublish].sort()).toEqual(["src_a/1", "src_b/2"]);
  });

  /** AC-3.2 (L301) — §3.3 L276 calls the date filter a correctness rule, not an optimisation. */
  test("two near-identical items with different dates produce two messages", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", { ...SAME_EVENT, date: "2026-08-30" });

    const result = await dedupBatch([a, b], deps());

    expect(result.writes).toHaveLength(2);
  });

  /** AC-3.5 (L304) — matched "without an intervening write". */
  test("the whole batch produces its writes only at the end", async () => {
    const { repo, deps: d } = repoDeps([]);

    await dedupBatch(twoNearIdenticalItems(), d);

    expect(repo.writeCount).toBe(0);
  });

  test("picks the strongest of several in-batch candidates", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", OTHER_EVENT);
    const c = item("chan_c/3", SAME_EVENT);

    const result = await dedupBatch([a, b, c], deps());

    const merged = result.writes.find((w) => w.kind === "create" && w.message.id === "chan_a/1");
    if (merged?.kind !== "create") throw new Error("expected chan_a/1");
    expect(Object.keys(merged.message.members).sort()).toEqual(["chan_a/1", "chan_c/3"]);
  });

  /** §3.3 L285 — title, category, country, location, peoples overwritten by the newest item. */
  test("the newest item's descriptive fields overwrite", async () => {
    const a = item("chan_a/1", { ...SAME_EVENT, title: "first", location: "Kyiv" });
    const b = item("chan_b/2", { ...SAME_EVENT, title: "second", location: "Lviv" });

    const result = await dedupBatch([a, b], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.title).toBe("second");
    expect(write.message.location).toBe("Lviv");
  });

  test("tags are merged, not replaced (§6 L532)", async () => {
    const a = item("chan_a/1", { ...SAME_EVENT, tags: "war,politics" });
    const b = item("chan_b/2", { ...SAME_EVENT, tags: "politics,drones" });

    const result = await dedupBatch([a, b], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.tags).toBe("politics,drones,war");
  });

  /** R30 — §6 L530 uses `??`, which preserves an empty-string image. */
  test("image keeps the existing value, including an empty string", async () => {
    const a = item("chan_a/1", { ...SAME_EVENT, image: "" });
    const b = item("chan_b/2", { ...SAME_EVENT, image: "https://img.test/b.jpg" });

    const result = await dedupBatch([a, b], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.image).toBe("");
  });

  /**
   * AC-3.6 (L305). R45 — §6 L533's elementwise mean has no analogue without a
   * vector; the union is what replaces it, and it must stay canonical (sorted,
   * deduplicated) or AC-3.7's byte-identical replay is impossible. R47 —
   * restates the criterion itself: "equals the element-wise mean of the two
   * input vectors" becomes "equals the sorted union of the two match keys".
   */
  test("a merged message's key is the sorted, deduplicated union of the inputs", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", {
      ...SAME_EVENT,
      properNames: "Minsk, Belaruskali, Naftan",
      tags: "fire,safety,industry",
    });

    const result = await dedupBatch([a, b], deps());

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.keyEntities).toEqual(["belaruskali", "minsk", "naftan"]);
    expect(write.message.keyTags).toEqual(["fire", "industry", "safety"]);
    for (const list of [write.message.keyEntities, write.message.keyTitle, write.message.keyTags]) {
      expect(list).toEqual([...new Set(list)].sort());
    }
  });
});

describe("Pass 2 — stored messages (§6 L513-519)", () => {
  test("merges into a stored message on the same date", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const stored = storedMessage({ id: "chan_z/9", ...keyOf(SAME_EVENT) });
    const { deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);

    expect(result.writes).toHaveLength(1);
    const write = result.writes[0];
    if (write?.kind !== "merge") throw new Error("expected a merge");
    expect(write.merge.id).toBe("chan_z/9");
    expect(Object.keys(write.merge.members)).toEqual(["chan_a/1"]);
  });

  /**
   * R44 — a record written before the match key existed parses as an empty one,
   * and `jaccard` defines empty-versus-empty as 0, so it never matches anything
   * and ages out of `date-index`. That is the whole of the migration story, and
   * it is only true if nothing special-cases the empty key into a match.
   */
  test("a stored record with no match key never matches", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const stored = storedMessage({ id: "chan_z/9" });
    const { deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);

    expect(result.writes[0]?.kind).toBe("create");
  });

  /**
   * R9. §7.2 L598 says nothing projects `members`, so a whole-record write built
   * from a date-index candidate would erase every member already stored. The
   * merge is attribute-level and the pre-existing member survives.
   */
  test("R9: merging into a stored message preserves its existing members", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const stored = storedMessage({ id: "chan_z/9", ...keyOf(SAME_EVENT) });
    const { repo, deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);
    const write = result.writes[0];
    if (write?.kind !== "merge") throw new Error("expected a merge");
    await repo.mergeMember(write.merge);

    const after = await repo.get("chan_z/9");
    expect(Object.keys(after?.members ?? {}).sort()).toEqual(["chan_a/1", "chan_z/9"]);
    expect(after?.memberCount).toBe(2);
    // R51 — the projection and the map stay in step across a merge, or the next
    // batch's short-circuit misses a member this one added.
    expect(after?.memberIds.sort()).toEqual(["chan_a/1", "chan_z/9"]);
  });

  /** AC-3.4 (L303), E2E-4 (L851). */
  test("merging into a published message resets it to topublish and keeps tgId", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const stored = storedMessage({
      id: "chan_z/9",
      status: "published",
      tgId: "4711",
      tgAt: 500,
      ...keyOf(SAME_EVENT),
    });
    const { repo, deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);
    const write = result.writes[0];
    if (write?.kind !== "merge") throw new Error("expected a merge");
    expect(write.merge.attributes.status).toBe("topublish");

    await repo.mergeMember(write.merge);
    const after = await repo.get("chan_z/9");
    expect(after?.status).toBe("topublish");
    expect(after?.tgId).toBe("4711");
    expect(after?.tgAt).toBe(500);
  });

  test("a stored message on a different date is never a candidate", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const stored = storedMessage({ id: "chan_z/9", date: "2026-08-30", ...keyOf(SAME_EVENT) });
    const { deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);

    expect(result.writes[0]?.kind).toBe("create");
  });

  /**
   * R10. Item A merges into stored M, so pending holds a fresher M. A literal
   * transcription re-reads M from the table for item B and overwrites the
   * batch's own work, destroying A's member.
   */
  test("R10: Pass 2 skips a candidate already touched in this batch", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
    const stored = storedMessage({ id: "chan_z/9", ...keyOf(SAME_EVENT) });
    const { repo, deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a, b], d);
    for (const write of result.writes) {
      if (write.kind === "merge") await repo.mergeMember(write.merge);
      else await repo.putNew(write.message);
    }

    const after = await repo.get("chan_z/9");
    expect(Object.keys(after?.members ?? {}).sort()).toEqual(["chan_a/1", "chan_b/2", "chan_z/9"]);
  });

  /**
   * R46 — §6 L513 runs Pass 2 only when Pass 1 found no match, which reads as a
   * yes/no answer a band does not give. Both passes run here and the single
   * highest score wins, so the stored candidates are examined even when an
   * in-batch one is already merge-worthy — `candidateCount` is what says they
   * were — and the closer of the two is the one the item joins.
   */
  test("a merge-worthy in-batch candidate survives an unrelated stored record", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", SAME_EVENT);
    const stored = storedMessage({ id: "chan_z/9", ...keyOf(OTHER_EVENT) });
    const { deps: d } = repoDeps([stored]);

    expect(scoreOf(a, b)).toBeGreaterThan(scoreOf(b, OTHER_EVENT));

    const result = await dedupBatch([a, b], d);

    expect(result.candidateCount).toBe(1);
    expect(result.writes).toHaveLength(1);
    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(Object.keys(write.message.members).sort()).toEqual(["chan_a/1", "chan_b/2"]);
  });

  /**
   * The divergence above, made observable — and it took a counterexample to
   * find, so the shape of it is worth stating.
   *
   * `1 - matchScore` is a weighted Jaccard distance and obeys the triangle
   * inequality, which makes a Pass-1 candidate that a stored one could outscore
   * *unreachable* while every Pass-1 candidate was created by an earlier item
   * in this batch: it would itself have been close enough to that stored record
   * to merge into it or to be held for a verdict, and either way it would not
   * be in `pending`.
   *
   * That argument does not cover a candidate `pending` holds because an earlier
   * item MERGED INTO it. Here `chan_y/8` and `chan_z/9` are two stored messages
   * on one date. `chan_a/1` merges into `chan_y/8` (1.00, against 0.80 for
   * `chan_z/9`), which puts a stored record into `pending`. `chan_b/2` then
   * scores 0.80 against it in Pass 1 — merge-worthy on its own — and 1.00
   * against `chan_z/9` in Pass 2. §6 L513 stops at Pass 1 and merges `chan_b/2`
   * into `chan_y/8`; taking the maximum puts it where it belongs.
   *
   * Without this test, an edit that returned to §6's structure would pass the
   * entire suite.
   */
  test("a stored candidate pulled into the batch does not shadow a closer one", async () => {
    const NARROW = { ...SAME_EVENT, properNames: "Minsk, Belaruskali" };
    const WIDE = { ...SAME_EVENT, properNames: "Minsk, Belaruskali, Naftan" };

    const near = storedMessage({ id: "chan_y/8", ...keyOf(NARROW) });
    const far = storedMessage({ id: "chan_z/9", ...keyOf(WIDE) });
    const a = item("chan_a/1", NARROW);
    const b = item("chan_b/2", WIDE);

    // The fixture, pinned: every Pass-1 score is merge-worthy, and the Pass-2
    // one for `b` is strictly better.
    expect(scoreOf(a, NARROW)).toBeGreaterThan(scoreOf(a, WIDE));
    expect(scoreOf(b, NARROW)).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    expect(scoreOf(b, WIDE)).toBeGreaterThan(scoreOf(b, NARROW));

    const { deps: d } = repoDeps([near, far]);
    const result = await dedupBatch([a, b], d);

    const into = (id: string) => result.writes.find((w) => w.kind === "merge" && w.merge.id === id);

    const toNear = into("chan_y/8");
    const toFar = into("chan_z/9");
    if (toNear?.kind !== "merge" || toFar?.kind !== "merge") {
      throw new Error("expected a merge into each stored message");
    }
    expect(Object.keys(toNear.merge.members)).toEqual(["chan_a/1"]);
    // The load-bearing one: §6 L513 would have put chan_b/2 here too.
    expect(Object.keys(toFar.merge.members)).toEqual(["chan_b/2"]);
  });

  /** §7.2 L600 — emitted per aggregate run, alarmed above 500. */
  test("emits DedupCandidateCount for the candidates it examined", async () => {
    const a = item("chan_a/1");
    const stored = [storedMessage({ id: "chan_z/9" }), storedMessage({ id: "chan_y/8" })];
    const { deps: d } = repoDeps(stored);

    const result = await dedupBatch([a], d);

    expect(result.candidateCount).toBe(2);
    expect(metrics.get("DedupCandidateCount")).toBe(2);
  });

  test("queries each date once, not once per item", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", OTHER_EVENT);
    let queries = 0;
    const { deps: d } = repoDeps([]);
    const counting: DedupDeps = {
      ...d,
      loadCandidatesByDate: async (date) => {
        queries++;
        return d.loadCandidatesByDate(date);
      },
    };

    await dedupBatch([a, b], counting);

    expect(queries).toBe(1);
  });
});

describe("the band (R46)", () => {
  test("auto-merges above the merge threshold without calling the model", async () => {
    const adjudicator = fakeAdjudicator(() => false);
    const result = await dedupBatch(twoNearIdenticalItems(), deps({ adjudicator }));

    expect(adjudicator.calls).toHaveLength(0);
    expect(result.writes).toHaveLength(1);
  });

  test("auto-splits below the distinct threshold without calling the model", async () => {
    const adjudicator = fakeAdjudicator(() => true);
    const result = await dedupBatch(twoUnrelatedItems(), deps({ adjudicator }));

    expect(adjudicator.calls).toHaveLength(0);
    expect(result.writes).toHaveLength(2);
  });

  /**
   * No `band` is injected here or in the two tests below, so `classify`'s own
   * default is what puts these items in the band. Swap `MERGE_THRESHOLD` and
   * `DISTINCT_THRESHOLD` in that default and a 0.533 pair classifies as `merge`
   * instead — no call is made and this fails.
   */
  test("adjudicates the band in ONE call for the whole batch", async () => {
    const adjudicator = fakeAdjudicator(() => true);
    await dedupBatch(threeAmbiguousItems(), deps({ adjudicator }));

    expect(adjudicator.calls).toHaveLength(1);
    expect(adjudicator.calls[0]?.map((pair) => pair.id)).toEqual([
      "src_b/2->src_a/1",
      "src_c/3->src_a/1",
    ]);
  });

  test("sends at most one pair per item — its highest-scoring candidate", async () => {
    const adjudicator = fakeAdjudicator(() => false);
    await dedupBatch(oneItemTwoCandidates(), deps({ adjudicator }));

    expect(adjudicator.calls).toHaveLength(1);
    expect(adjudicator.calls[0]?.map((pair) => pair.id)).toEqual(["src_c/3->src_a/1"]);
  });

  test("a 'same' verdict merges and a 'different' verdict splits", async () => {
    const merged = await dedupBatch(
      twoAmbiguousItems(),
      deps({ adjudicator: fakeAdjudicator(() => true) }),
    );
    const split = await dedupBatch(
      twoAmbiguousItems(),
      deps({ adjudicator: fakeAdjudicator(() => false) }),
    );

    expect(merged.writes).toHaveLength(1);
    expect(split.writes).toHaveLength(2);
  });

  /**
   * The two sides are described in the same terms — real `title`, `category`
   * and `location` on both, the canonical key for `entities` and `tags` on
   * both. An asymmetry here would make part of every verdict an artefact of
   * which side happened to be stored.
   */
  test("both sides of a pair are described the same way", async () => {
    const adjudicator = fakeAdjudicator(() => false);
    await dedupBatch(twoAmbiguousItems(), deps({ adjudicator }));

    const pair = adjudicator.calls[0]?.[0];
    expect(pair?.item).toEqual({
      title: "Alpha Gamma",
      entities: ["belaruskali", "minsk", "naftan"],
      tags: ["fire", "industry"],
      category: "geopolitics",
      location: "Kyiv",
      date: DATE,
    });
    expect(pair?.candidate).toEqual({
      title: "Alpha Beta",
      entities: ["belaruskali", "minsk"],
      tags: ["fire", "safety"],
      category: "geopolitics",
      location: "Kyiv",
      date: DATE,
    });
  });

  /**
   * §7.2 L598's projection carries the key and `memberIds` and nothing else, so
   * a stored candidate's `title` costs a base-table read. Without it the model
   * would receive exactly the three token sets `matchScore` has just failed to
   * decide on — a tie broken with the data that produced it.
   */
  test("a stored band candidate is described from its base record, read once", async () => {
    const [first, second] = twoAmbiguousItems();
    if (first === undefined || second === undefined) throw new Error("fixture");
    const stored = storedMessage({
      id: "chan_z/9",
      ...keyOf(first),
      title: "Fire At The Potash Plant",
      category: "industry",
      location: "Salihorsk",
    });
    const adjudicator = fakeAdjudicator(() => false);
    const repo = fakeMessageRepo([stored]);
    const counting = countingReads({ loadMessage: repo.get });

    await dedupBatch(
      [second],
      deps({ adjudicator, loadCandidatesByDate: repo.queryByDate, ...counting.deps }),
    );

    const pair = adjudicator.calls[0]?.[0];
    expect(pair?.candidate.title).toBe("Fire At The Potash Plant");
    expect(pair?.candidate.category).toBe("industry");
    expect(pair?.candidate.location).toBe("Salihorsk");
    // The key still supplies the canonical entity and tag sets.
    expect(pair?.candidate.entities).toEqual(["belaruskali", "minsk"]);
    // One read, not one per use: the merge branch would want the same record.
    expect(counting.reads).toEqual(["chan_z/9"]);
  });

  /**
   * §5.3's multilingual embedder existed to serve `summary` (Belarusian) and
   * `body` (Russian or Ukrainian). Neither crosses this boundary, and the
   * exhaustive key check is what keeps a later field from drifting across it.
   */
  test("no source text reaches the model", async () => {
    const adjudicator = fakeAdjudicator(() => false);
    await dedupBatch(twoAmbiguousItems(), deps({ adjudicator }));

    const pair = adjudicator.calls[0]?.[0];
    for (const side of [pair?.item, pair?.candidate]) {
      expect(Object.keys(side ?? {}).sort()).toEqual([
        "category",
        "date",
        "entities",
        "location",
        "tags",
        "title",
      ]);
    }
    expect(JSON.stringify(adjudicator.calls)).not.toContain("summary");
    expect(JSON.stringify(adjudicator.calls)).not.toContain("body of");
  });

  /** The read is the band's alone: an auto verdict must cost nothing extra. */
  test("neither auto verdict reads a base record", async () => {
    const stored = storedMessage({ id: "chan_z/9", ...keyOf(OTHER_EVENT) });
    const repo = fakeMessageRepo([stored]);
    const counting = countingReads({ loadMessage: repo.get });

    // One pair scores 1.00 (auto-merge, in batch) and both score 0.00 against
    // the stored record (auto-split). Neither needs the base table.
    await dedupBatch(
      twoNearIdenticalItems(),
      deps({ loadCandidatesByDate: repo.queryByDate, ...counting.deps }),
    );

    expect(counting.reads).toEqual([]);
  });

  /**
   * A degraded verdict beats a failed batch — this path already splits when the
   * model itself is unavailable, so it must not throw when the record is.
   */
  test.each([
    ["a record that is gone", async () => undefined],
    [
      "a read that throws",
      async () => {
        throw new Error("ProvisionedThroughputExceededException");
      },
    ],
  ])("%s still produces a pair, from the key", async (_name, loadMessage) => {
    const [first, second] = twoAmbiguousItems();
    if (first === undefined || second === undefined) throw new Error("fixture");
    const stored = storedMessage({ id: "chan_z/9", ...keyOf(first), title: "Never Read" });
    const repo = fakeMessageRepo([stored]);
    const adjudicator = fakeAdjudicator(() => false);

    const result = await dedupBatch(
      [second],
      deps({ adjudicator, loadCandidatesByDate: repo.queryByDate, loadMessage }),
    );

    // Falls back to the key-derived title — lowercased and alphabetised, which
    // is exactly why it is a fallback and not the design.
    expect(adjudicator.calls[0]?.[0]?.candidate.title).toBe("alpha beta");
    expect(adjudicator.calls[0]?.[0]?.candidate.category).toBeUndefined();
    expect(result.writes).toHaveLength(1);
  });

  /**
   * A verdict map that answers some pairs and not others splits the ones it did
   * not answer. `Adjudicator`'s own parser rejects a partial response, so this
   * pins the defence behind it: `verdicts.get(id) === true`, never a truthiness
   * test that would read `undefined` as a decision.
   */
  test("a partial verdict map merges only what it answered", async () => {
    const answered: string[] = [];
    const partial: Adjudicator = {
      adjudicate: async (pairs) => {
        const [only] = pairs;
        if (only === undefined) return new Map();
        answered.push(only.id);
        return new Map([[only.id, true]]);
      },
    };

    const result = await dedupBatch(threeAmbiguousItems(), deps({ adjudicator: partial }));

    expect(answered).toEqual(["src_b/2->src_a/1"]);
    // src_b/2 merged on its verdict; src_c/3 had none and split.
    expect(result.writes).toHaveLength(2);
    const merged = result.writes.find((w) => w.kind === "create" && w.message.id === "src_a/1");
    if (merged?.kind !== "create") throw new Error("expected src_a/1");
    expect(Object.keys(merged.message.members).sort()).toEqual(["src_a/1", "src_b/2"]);
    expect(result.writes.some((w) => w.kind === "create" && w.message.id === "src_c/3")).toBe(true);
  });

  /** R50 — the band is a cost centre, so its volume is a counted number. */
  test("counts the pairs it sent", async () => {
    await dedupBatch(threeAmbiguousItems(), deps({ adjudicator: fakeAdjudicator(() => true) }));

    expect(metrics.get("DedupAdjudicated")).toBe(2);
    expect(metrics.get("DedupAdjudicationFailed")).toBe(0);
  });

  /** §11.3 L868 — "False merges are worse than false splits." */
  test("a failing adjudication splits rather than merging", async () => {
    const result = await dedupBatch(
      twoAmbiguousItems(),
      deps({ adjudicator: failingAdjudicator() }),
    );

    expect(result.writes).toHaveLength(2);
    expect(metrics.get("DedupAdjudicationFailed")).toBe(1);
    expect(metrics.get("DedupAdjudicated")).toBe(0);
  });

  /**
   * And it is a handled failure, not a thrown batch: the unambiguous items in a
   * batch must still be written, or one flaky model call dead-letters ten posts.
   */
  test("a failing adjudication still writes the items that were never ambiguous", async () => {
    const batch = [...twoAmbiguousItems(), item("chan_z/9", OTHER_EVENT)];

    const result = await dedupBatch(batch, deps({ adjudicator: failingAdjudicator() }));

    expect(
      result.writes.map((w) => (w.kind === "create" ? w.message.id : w.merge.id)).sort(),
    ).toEqual(["chan_z/9", "src_a/1", "src_b/2"]);
    expect(sink.lines.map((line) => JSON.parse(line).level)).toContain("error");
  });

  /**
   * §11.3's recalibration is a configuration change, not a code edit — the
   * rationale `similarityThreshold` carried, kept for the band.
   */
  test("an injected band overrides the default in both directions", async () => {
    const strict = await dedupBatch(
      twoNearIdenticalItems(),
      deps({ band: { merge: 1.5, distinct: 1.4 }, adjudicator: fakeAdjudicator(() => false) }),
    );
    const loose = await dedupBatch(
      twoUnrelatedItems(),
      deps({ band: { merge: 0, distinct: -1 }, adjudicator: fakeAdjudicator(() => false) }),
    );

    expect(strict.writes).toHaveLength(2);
    expect(loose.writes).toHaveLength(1);
  });
});

describe("the replay short-circuit (R51, AC-3.7)", () => {
  /**
   * The stored record's key is `OTHER_EVENT` and the item's is `SAME_EVENT`, so
   * the pair scores 0. Only identity can merge them, which is the point: §3.3
   * L285 lets later members overwrite the descriptive fields, so a replayed item
   * can have drifted right out of the key it helped build.
   */
  test("an item already in a candidate's memberIds merges there with no scoring", async () => {
    const adjudicator = fakeAdjudicator(() => false);
    const stored = storedMessage({
      id: "chan_z/9",
      ...keyOf(OTHER_EVENT),
      members: {
        "chan_z/9": { summary: "first", links: [], channel: "chan_z", ts: 1 },
        "chan_a/1": { summary: "second", links: [], channel: "chan_a", ts: 2 },
      },
    });
    const { deps: d } = repoDeps([stored], { adjudicator });

    const result = await dedupBatch([item("chan_a/1", SAME_EVENT)], d);

    expect(adjudicator.calls).toHaveLength(0);
    expect(result.writes).toHaveLength(1);
    const write = result.writes[0];
    if (write?.kind !== "merge") throw new Error("expected a merge");
    expect(write.merge.id).toBe("chan_z/9");
    expect(metrics.get("MessagesCreated")).toBe(0);
  });

  /** Without the projection there is nothing to short-circuit on. */
  test("a candidate whose memberIds do not list the item is scored as usual", async () => {
    const stored = storedMessage({ id: "chan_z/9", ...keyOf(OTHER_EVENT), memberIds: [] });
    const { deps: d } = repoDeps([stored]);

    const result = await dedupBatch([item("chan_a/1", SAME_EVENT)], d);

    expect(result.writes[0]?.kind).toBe("create");
  });

  /** A member of *yesterday's* message is not a member of today's story. */
  test("the short-circuit is still confined to the item's own date", async () => {
    const stored = storedMessage({
      id: "chan_z/9",
      date: "2026-08-30",
      memberIds: ["chan_z/9", "chan_a/1"],
    });
    const { deps: d } = repoDeps([stored]);

    const result = await dedupBatch([item("chan_a/1")], d);

    expect(result.writes[0]?.kind).toBe("create");
  });
});

describe("member cap (§6 L525-526)", () => {
  const fullMembers = (): Record<string, MemberBlock> =>
    Object.fromEntries(
      Array.from({ length: MAX_MEMBERS }, (_, i) => [
        `chan_full/${i + 1}`,
        { summary: `s${i}`, links: [], channel: "chan_full", ts: i },
      ]),
    );

  /** AC-3.8 (L307). */
  test("a 21st member is dropped entirely and memberCount stays at 20", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const stored = storedMessage({
      id: "chan_full/1",
      members: fullMembers(),
      ...keyOf(SAME_EVENT),
    });
    const { deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);

    expect(result.writes).toEqual([]);
    expect(result.toPublish).toEqual([]);
    expect(metrics.get("MemberCapReached")).toBe(1);
  });

  /** §6 L525's carve-out: `and item.id not in match.members`. */
  test("replaying an item already in a full map still merges", async () => {
    const a = item("chan_full/1", SAME_EVENT);
    const stored = storedMessage({
      id: "chan_full/1",
      members: fullMembers(),
      ...keyOf(SAME_EVENT),
    });
    const { deps: d } = repoDeps([stored]);

    const result = await dedupBatch([a], d);

    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]?.kind).toBe("merge");
    expect(metrics.get("MemberCapReached")).toBe(0);
    if (result.writes[0]?.kind !== "merge") throw new Error("expected a merge");
    expect(result.writes[0].merge.attributes.memberCount).toBe(MAX_MEMBERS);
  });
});

/**
 * R51 — AC-3.7's wording is unchanged ("replaying the identical item message
 * produces a byte-identical message record"), but not how it holds. §3.3
 * L285 makes it an emergent property of idempotent member writes; here a
 * replayed item is caught by the `memberIds` short-circuit above (before any
 * scoring runs) and merges into the exact record it already belongs to, so
 * byte-identical replay is guaranteed rather than emergent.
 */
describe("replay idempotency (AC-3.7 L306, E2E-5 L852)", () => {
  /**
   * Run under an advancing clock, deliberately. R11: §6 L522 stamps
   * `ts: now()` into every member block, so a frozen clock makes a
   * non-idempotent implementation look idempotent — the second write happens to
   * produce the same timestamp. Only a moving clock proves the block's ts is
   * preserved rather than rewritten.
   */
  test("replaying an item preserves its member block, ts included", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const { repo, deps: d } = repoDeps([], { clock: advancingClock(1000, 500) });

    const first = await dedupBatch([a], d);
    if (first.writes[0]?.kind !== "create") throw new Error("expected a create");
    await repo.putNew(first.writes[0].message);
    const before = await repo.get("chan_a/1");

    const second = await dedupBatch([a], d);
    if (second.writes[0]?.kind !== "merge") throw new Error("expected a merge");
    await repo.mergeMember(second.writes[0].merge);
    const after = await repo.get("chan_a/1");

    expect(after?.members).toEqual(before?.members);
    expect(after?.memberCount).toBe(before?.memberCount);
    expect(after?.tags).toBe(before?.tags);
  });

  /**
   * R45 — `unionMatchKeys` is idempotent, which is what replaces §6 L559's
   * "the mean of a vector with itself is that vector". Unlike the centroid it
   * does not drift at all, so this holds for a multi-member message too.
   */
  test("replaying an item leaves the match key byte-identical", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const b = item("chan_b/2", { ...SAME_EVENT, properNames: "Minsk, Belaruskali, Naftan" });
    const { repo, deps: d } = repoDeps([], { clock: advancingClock(1000, 500) });

    const first = await dedupBatch([a, b], d);
    if (first.writes[0]?.kind !== "create") throw new Error("expected a create");
    await repo.putNew(first.writes[0].message);
    const before = await repo.get("chan_a/1");

    const second = await dedupBatch([a, b], d);
    for (const write of second.writes) {
      if (write.kind !== "merge") throw new Error("expected merges only");
      await repo.mergeMember(write.merge);
    }
    const after = await repo.get("chan_a/1");

    expect(JSON.stringify([after?.keyEntities, after?.keyTitle, after?.keyTags])).toBe(
      JSON.stringify([before?.keyEntities, before?.keyTitle, before?.keyTags]),
    );
    expect(after?.memberIds).toEqual(before?.memberIds);
  });

  /**
   * This test previously asserted the opposite — that a replay still enqueues,
   * and SQS's five-minute FIFO deduplication window collapses it rather than
   * this code. R39 changed that deliberately: the window is five minutes, and a
   * DLQ drained an hour after the failure is outside it, so every replayed
   * message was re-published as an `editMessageText` carrying its own text.
   * Item 8.6 measured that against E2E-5, which calls itself the master
   * idempotency test.
   *
   * SQS deduplication is still the backstop for a replay *inside* the window.
   * It is no longer the only thing standing between a DLQ drain and one Telegram
   * call per message.
   */
  test("a replay enqueues nothing, rather than relying on SQS's 5-minute window", async () => {
    const a = item("chan_a/1", SAME_EVENT);
    const { repo, deps: d } = repoDeps([]);

    const first = await dedupBatch([a], d);
    if (first.writes[0]?.kind !== "create") throw new Error("expected a create");
    await repo.putNew(first.writes[0].message);

    const second = await dedupBatch([a], d);

    expect(second.toPublish).toEqual([]);
  });
});

describe("metrics", () => {
  test("counts creates and merges separately (§7.7 L689)", async () => {
    await dedupBatch(twoNearIdenticalItems(), deps());

    expect(metrics.get("MessagesCreated")).toBe(1);
    expect(metrics.get("MessagesMerged")).toBe(1);
  });
});

describe("a merge that changes nothing does not re-publish (R39)", () => {
  /**
   * §2.3 L168 argues idempotency is free: "Re-processing a replayed item writes
   * `members.{itemId}` with the same value — a no-op." §6 L527's merge branch
   * writes `status: "topublish"` unconditionally, which is what stops it being
   * one — a replayed message returns to the publish queue and §3.4 L340 edits
   * the live post with identical text.
   */
  test("a replayed member leaves the status alone", async () => {
    const replayed = item("chan_a/1", SAME_EVENT);
    const existing = replayable(replayed, { status: "published" });
    const { deps: d } = repoDeps([existing]);

    const result = await dedupBatch([replayed], d);

    const [write] = result.writes;
    expect(write?.kind).toBe("merge");
    expect(write?.kind === "merge" ? write.merge.attributes.status : undefined).toBeUndefined();
  });

  test("and is not enqueued for publishing", async () => {
    const replayed = item("chan_a/1", SAME_EVENT);
    const existing = replayable(replayed, { status: "published" });
    const { deps: d } = repoDeps([existing]);

    const result = await dedupBatch([replayed], d);

    expect(result.toPublish).toEqual([]);
  });

  /**
   * The other direction, which is E2E-4: a merge that genuinely adds a member
   * must still return the message to `topublish`, or the live post never gains
   * the new member.
   */
  test("a merge that adds a member still republishes", async () => {
    const first = item("chan_a/1", SAME_EVENT);
    const second = item("chan_b/2", SAME_EVENT);
    const existing = replayable(first, { status: "published" });
    const { deps: d } = repoDeps([existing]);

    const result = await dedupBatch([second], d);

    const [write] = result.writes;
    expect(write?.kind === "merge" ? write.merge.attributes.status : undefined).toBe("topublish");
    expect(result.toPublish).toEqual([existing.id]);
  });

  /**
   * A post edited upstream keeps its item id but changes its summary, so the
   * member block differs and the live message must be corrected.
   */
  test("a replayed item whose content changed does republish", async () => {
    const original = item("chan_a/1", SAME_EVENT);
    const existing = replayable(original, { status: "published" });
    const edited = item("chan_a/1", { ...SAME_EVENT, summary: "summary chan_a/1 (updated)" });
    const { deps: d } = repoDeps([existing]);

    const result = await dedupBatch([edited], d);

    const [write] = result.writes;
    expect(write?.kind === "merge" ? write.merge.attributes.status : undefined).toBe("topublish");
  });
});
