import { beforeEach, describe, expect, test } from "vitest";
import { stubEmbedder, unitVectorAtAngle } from "../../test/fakes/ai.js";
import { advancingClock, fixedClock } from "../../test/fakes/clock.js";
import { fakeMessageRepo } from "../../test/fakes/db.js";
import { recordingMetrics } from "../../test/fakes/metrics.js";
import { packEmbedding, unpackEmbedding } from "../db/embeddingCodec.js";
import { type AnalyzedItem, AnalyzedItemSchema } from "../domain/item.js";
import { type MemberBlock, type Message, MessageSchema } from "../domain/message.js";
import { DIMENSIONS, MAX_MEMBERS, SIMILARITY_THRESHOLD } from "./constants.js";
import { cosineSimilarity } from "./cosine.js";
import { type DedupDeps, dedupBatch } from "./dedupBatch.js";
import { buildEmbeddingText } from "./embeddingText.js";

const DATE = "2026-08-29";

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

/** Scripts one vector per item, keyed by the text §6 L495 actually embeds. */
function embedderFor(pairs: readonly (readonly [AnalyzedItem, number[]])[]) {
  return stubEmbedder(Object.fromEntries(pairs.map(([i, v]) => [buildEmbeddingText(i), v])));
}

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
    ...over,
    members,
    memberCount: Object.keys(members).length,
  });
}

/**
 * A stored message whose single member is exactly what `item(id)` would produce,
 * so re-processing that item is a true replay — R11 preserves the `ts`, and the
 * block compares equal.
 */
function replayable(source: AnalyzedItem, over: Partial<Message> = {}): Message {
  return storedMessage({
    id: source.id,
    embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
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

const replayDeps = (stored: readonly Message[], items: readonly AnalyzedItem[]) => {
  const repo = fakeMessageRepo(stored);
  return {
    loadCandidatesByDate: repo.queryByDate,
    loadMessage: repo.get,
    clock: fixedClock(9000),
    metrics,
    embeddings: embedderFor(items.map((i) => [i, unitVectorAtAngle(1, DIMENSIONS)])),
  } satisfies DedupDeps;
};

let metrics: ReturnType<typeof recordingMetrics>;

beforeEach(() => {
  metrics = recordingMetrics();
});

function deps(over: Partial<DedupDeps> & Pick<DedupDeps, "embeddings">): DedupDeps {
  const repo = fakeMessageRepo([]);
  return {
    loadCandidatesByDate: repo.queryByDate,
    loadMessage: repo.get,
    clock: fixedClock(1000),
    metrics,
    ...over,
  };
}

function repoDeps(
  stored: readonly Message[],
  over: Partial<DedupDeps> & Pick<DedupDeps, "embeddings">,
) {
  const repo = fakeMessageRepo(stored);
  return {
    repo,
    deps: {
      loadCandidatesByDate: repo.queryByDate,
      loadMessage: repo.get,
      clock: fixedClock(1000),
      metrics,
      ...over,
    } as DedupDeps,
  };
}

describe("empty batch", () => {
  test("makes no provider call, no query and no write", async () => {
    const embeddings = stubEmbedder({});
    const { repo, deps: d } = repoDeps([], { embeddings });

    const result = await dedupBatch([], d);

    expect(result.writes).toEqual([]);
    expect(result.toPublish).toEqual([]);
    expect(embeddings.batches).toEqual([]);
    expect(repo.writeCount).toBe(0);
  });
});

describe("create branch (§6 L538-541)", () => {
  test("a single item becomes one message keyed by its own id", async () => {
    const a = item("chan_a/1");
    const result = await dedupBatch([a], deps({ embeddings: embedderFor([[a, [1, 0]]]) }));

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
    const result = await dedupBatch([a], deps({ embeddings: embedderFor([[a, [1, 0]]]) }));

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
    const a = item("chan_a/1");
    const b = item("chan_b/2", { tgChannel: "other_news", body: "unrelated" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, [1, 0]],
          [b, [0, 1]],
        ]),
      }),
    );

    const channels = result.writes.map((w) => (w.kind === "create" ? w.message.tgChannel : ""));
    expect(channels).toEqual(["telegator_news", "other_news"]);
  });

  test("stores the item's own vector as the embedding", async () => {
    const a = item("chan_a/1");
    const vec = unitVectorAtAngle(1, DIMENSIONS);
    const result = await dedupBatch([a], deps({ embeddings: embedderFor([[a, vec]]) }));

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(
      cosineSimilarity(unpackEmbedding(write.message.embedding ?? new Uint8Array()), vec),
    ).toBeCloseTo(1, 6);
  });

  test("R7: item-only fields never reach the record", async () => {
    const a = item("chan_a/1");
    const result = await dedupBatch([a], deps({ embeddings: embedderFor([[a, [1, 0]]]) }));

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    for (const key of ["body", "kind", "importance", "properNames", "links"]) {
      expect(write.message).not.toHaveProperty(key);
    }
  });

  test("R8: every created record carries ts, the sort key on both GSIs", async () => {
    const a = item("chan_a/1");
    const result = await dedupBatch(
      [a],
      deps({ embeddings: embedderFor([[a, [1, 0]]]), clock: fixedClock(9999) }),
    );

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.ts).toBe(9999);
  });
});

describe("Pass 1 — intra-batch matching (§6 L505-511)", () => {
  /** AC-3.1 (L300). */
  test("two items at 0.90 on the same date produce one message with two members", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.9, DIMENSIONS)],
        ]),
      }),
    );

    expect(result.writes).toHaveLength(1);
    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(Object.keys(write.message.members).sort()).toEqual(["chan_a/1", "chan_b/2"]);
    expect(write.message.memberCount).toBe(2);
    expect(write.message.id).toBe("chan_a/1");
  });

  /** AC-3.3 (L302). */
  test("two items at 0.80 produce two messages", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.8, DIMENSIONS)],
        ]),
      }),
    );

    expect(result.writes).toHaveLength(2);
    expect([...result.toPublish].sort()).toEqual(["chan_a/1", "chan_b/2"]);
  });

  /** AC-3.2 (L301) — §3.3 L276 calls the date filter a correctness rule, not an optimisation. */
  test("two items at 0.90 with different dates produce two messages", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body", date: "2026-08-30" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.9, DIMENSIONS)],
        ]),
      }),
    );

    expect(result.writes).toHaveLength(2);
  });

  /** AC-3.5 (L304) — matched "without an intervening write". */
  test("the whole batch produces its writes only at the end", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const { repo, deps: d } = repoDeps([], {
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, DIMENSIONS)],
        [b, unitVectorAtAngle(0.9, DIMENSIONS)],
      ]),
    });

    await dedupBatch([a, b], d);

    expect(repo.writeCount).toBe(0);
  });

  test("picks the strongest of several in-batch candidates", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "b body" });
    const c = item("chan_c/3", { body: "c body" });
    const result = await dedupBatch(
      [a, b, c],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.2, DIMENSIONS)],
          [c, unitVectorAtAngle(0.95, DIMENSIONS)],
        ]),
      }),
    );

    const merged = result.writes.find((w) => w.kind === "create" && w.message.id === "chan_a/1");
    if (merged?.kind !== "create") throw new Error("expected chan_a/1");
    expect(Object.keys(merged.message.members).sort()).toEqual(["chan_a/1", "chan_c/3"]);
  });

  /** §3.3 L285 — title, category, country, location, peoples overwritten by the newest item. */
  test("the newest item's descriptive fields overwrite", async () => {
    const a = item("chan_a/1", { title: "first", location: "Kyiv" });
    const b = item("chan_b/2", { body: "second", title: "second", location: "Lviv" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.99, DIMENSIONS)],
        ]),
      }),
    );

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.title).toBe("second");
    expect(write.message.location).toBe("Lviv");
  });

  test("tags are merged, not replaced (§6 L532)", async () => {
    const a = item("chan_a/1", { tags: "war,politics" });
    const b = item("chan_b/2", { body: "second", tags: "politics,drones" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.99, DIMENSIONS)],
        ]),
      }),
    );

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.tags).toBe("politics,drones,war");
  });

  /** R30 — §6 L530 uses `??`, which preserves an empty-string image. */
  test("image keeps the existing value, including an empty string", async () => {
    const a = item("chan_a/1", { image: "" });
    const b = item("chan_b/2", { body: "second", image: "https://img.test/b.jpg" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.99, DIMENSIONS)],
        ]),
      }),
    );

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    expect(write.message.image).toBe("");
  });

  /** AC-3.6 (L305), and R6's pairwise mean. */
  test("the merged embedding is the elementwise mean of the two vectors", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second" });
    const va = unitVectorAtAngle(1, DIMENSIONS);
    const vb = unitVectorAtAngle(0.9, DIMENSIONS);
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, va],
          [b, vb],
        ]),
      }),
    );

    const write = result.writes[0];
    if (write?.kind !== "create") throw new Error("expected a create");
    const stored = unpackEmbedding(write.message.embedding ?? new Uint8Array());
    expect(stored[0]).toBeCloseTo(((va[0] as number) + (vb[0] as number)) / 2, 6);
    expect(stored[1]).toBeCloseTo(((va[1] as number) + (vb[1] as number)) / 2, 6);
  });
});

describe("Pass 2 — stored messages (§6 L513-519)", () => {
  test("merges into a stored message on the same date", async () => {
    const a = item("chan_a/1");
    const stored = storedMessage({
      id: "chan_z/9",
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { deps: d } = repoDeps([stored], {
      embeddings: embedderFor([[a, unitVectorAtAngle(0.95, DIMENSIONS)]]),
    });

    const result = await dedupBatch([a], d);

    expect(result.writes).toHaveLength(1);
    const write = result.writes[0];
    if (write?.kind !== "merge") throw new Error("expected a merge");
    expect(write.merge.id).toBe("chan_z/9");
    expect(Object.keys(write.merge.members)).toEqual(["chan_a/1"]);
  });

  /**
   * R9. §7.2 L598 says nothing projects `members`, so a whole-record write built
   * from a date-index candidate would erase every member already stored. The
   * merge is attribute-level and the pre-existing member survives.
   */
  test("R9: merging into a stored message preserves its existing members", async () => {
    const a = item("chan_a/1");
    const stored = storedMessage({
      id: "chan_z/9",
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { repo, deps: d } = repoDeps([stored], {
      embeddings: embedderFor([[a, unitVectorAtAngle(0.95, DIMENSIONS)]]),
    });

    const result = await dedupBatch([a], d);
    const write = result.writes[0];
    if (write?.kind !== "merge") throw new Error("expected a merge");
    await repo.mergeMember(write.merge);

    const after = await repo.get("chan_z/9");
    expect(Object.keys(after?.members ?? {}).sort()).toEqual(["chan_a/1", "chan_z/9"]);
    expect(after?.memberCount).toBe(2);
  });

  /** AC-3.4 (L303), E2E-4 (L851). */
  test("merging into a published message resets it to topublish and keeps tgId", async () => {
    const a = item("chan_a/1");
    const stored = storedMessage({
      id: "chan_z/9",
      status: "published",
      tgId: "4711",
      tgAt: 500,
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { repo, deps: d } = repoDeps([stored], {
      embeddings: embedderFor([[a, unitVectorAtAngle(0.95, DIMENSIONS)]]),
    });

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

  test("a stored message on a different date is never queried", async () => {
    const a = item("chan_a/1");
    const stored = storedMessage({
      id: "chan_z/9",
      date: "2026-08-30",
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { deps: d } = repoDeps([stored], {
      embeddings: embedderFor([[a, unitVectorAtAngle(1, DIMENSIONS)]]),
    });

    const result = await dedupBatch([a], d);

    expect(result.writes[0]?.kind).toBe("create");
  });

  /**
   * R10. Item A merges into stored M, so pending holds a fresher M. Item B
   * scores below threshold against that fresher copy but above it against the
   * still-stale stored copy. A literal transcription re-reads M from the table
   * and overwrites the batch's own work, destroying A's member.
   */
  test("R10: Pass 2 skips a candidate already touched in this batch", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const stored = storedMessage({
      id: "chan_z/9",
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { repo, deps: d } = repoDeps([stored], {
      embeddings: embedderFor([
        [a, unitVectorAtAngle(0.99, DIMENSIONS)],
        [b, unitVectorAtAngle(0.9, DIMENSIONS)],
      ]),
    });

    const result = await dedupBatch([a, b], d);
    for (const write of result.writes) {
      if (write.kind === "merge") await repo.mergeMember(write.merge);
      else await repo.putNew(write.message);
    }

    const after = await repo.get("chan_z/9");
    expect(Object.keys(after?.members ?? {}).sort()).toEqual(["chan_a/1", "chan_b/2", "chan_z/9"]);
  });

  /** §7.2 L600 — emitted per aggregate run, alarmed above 500. */
  test("emits DedupCandidateCount for the candidates it examined", async () => {
    const a = item("chan_a/1");
    const stored = [
      storedMessage({
        id: "chan_z/9",
        embedding: packEmbedding(unitVectorAtAngle(0.1, DIMENSIONS)),
      }),
      storedMessage({
        id: "chan_y/8",
        embedding: packEmbedding(unitVectorAtAngle(0.2, DIMENSIONS)),
      }),
    ];
    const { deps: d } = repoDeps(stored, {
      embeddings: embedderFor([[a, unitVectorAtAngle(1, DIMENSIONS)]]),
    });

    const result = await dedupBatch([a], d);

    expect(result.candidateCount).toBe(2);
    expect(metrics.get("DedupCandidateCount")).toBe(2);
  });

  test("queries each date once, not once per item", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    let queries = 0;
    const { deps: d } = repoDeps([], {
      embeddings: embedderFor([
        [a, unitVectorAtAngle(1, DIMENSIONS)],
        [b, unitVectorAtAngle(0.1, DIMENSIONS)],
      ]),
    });
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

describe("threshold boundary (§6 L511, L518)", () => {
  test("a pair at exactly the threshold merges, because >= is inclusive", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const va = unitVectorAtAngle(1, DIMENSIONS);
    const vb = unitVectorAtAngle(0.9, DIMENSIONS);
    const exact = cosineSimilarity(va, vb);

    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, va],
          [b, vb],
        ]),
        similarityThreshold: exact,
      }),
    );

    expect(result.writes).toHaveLength(1);
  });

  test("the next representable value above the score does not merge", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const va = unitVectorAtAngle(1, DIMENSIONS);
    const vb = unitVectorAtAngle(0.9, DIMENSIONS);
    const justAbove = cosineSimilarity(va, vb) + Number.EPSILON;

    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, va],
          [b, vb],
        ]),
        similarityThreshold: justAbove,
      }),
    );

    expect(result.writes).toHaveLength(2);
  });

  test("defaults to the §6 L491 threshold when none is injected", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const result = await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(SIMILARITY_THRESHOLD - 0.01, DIMENSIONS)],
        ]),
      }),
    );

    expect(result.writes).toHaveLength(2);
  });

  /**
   * §6 L510 sets bestScore on any improvement, with no threshold test, and L518
   * then requires `s > bestScore`. A sub-threshold Pass-1 score therefore looks
   * like a floor on Pass 2. It provably is not — Pass 2 only runs when no match
   * was found, which means bestScore < threshold, and Pass 2 requires
   * s >= threshold. This pins the equivalence so a future edit cannot make the
   * carry-over live.
   */
  test("a sub-threshold Pass-1 best does not block a qualifying Pass-2 candidate", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    const stored = storedMessage({
      id: "chan_z/9",
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { deps: d } = repoDeps([stored], {
      embeddings: embedderFor([
        [a, unitVectorAtAngle(0.1, DIMENSIONS)],
        [b, unitVectorAtAngle(0.95, DIMENSIONS)],
      ]),
    });

    const result = await dedupBatch([a, b], d);

    const merge = result.writes.find((w) => w.kind === "merge");
    expect(merge).toBeDefined();
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
    const a = item("chan_a/1");
    const stored = storedMessage({
      id: "chan_full/1",
      members: fullMembers(),
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { deps: d } = repoDeps([stored], {
      embeddings: embedderFor([[a, unitVectorAtAngle(0.99, DIMENSIONS)]]),
    });

    const result = await dedupBatch([a], d);

    expect(result.writes).toEqual([]);
    expect(result.toPublish).toEqual([]);
    expect(metrics.get("MemberCapReached")).toBe(1);
  });

  /** §6 L525's carve-out: `and item.id not in match.members`. */
  test("replaying an item already in a full map still merges", async () => {
    const members = fullMembers();
    const a = item("chan_full/1");
    const stored = storedMessage({
      id: "chan_full/1",
      members,
      embedding: packEmbedding(unitVectorAtAngle(1, DIMENSIONS)),
    });
    const { deps: d } = repoDeps([stored], {
      embeddings: embedderFor([[a, unitVectorAtAngle(0.99, DIMENSIONS)]]),
    });

    const result = await dedupBatch([a], d);

    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]?.kind).toBe("merge");
    expect(metrics.get("MemberCapReached")).toBe(0);
    if (result.writes[0]?.kind !== "merge") throw new Error("expected a merge");
    expect(result.writes[0].merge.attributes.memberCount).toBe(MAX_MEMBERS);
  });
});

describe("replay idempotency (AC-3.7 L306, E2E-5 L852)", () => {
  /**
   * Run under an advancing clock, deliberately. R11: §6 L522 stamps
   * `ts: now()` into every member block, so a frozen clock makes a
   * non-idempotent implementation look idempotent — the second write happens to
   * produce the same timestamp. Only a moving clock proves the block's ts is
   * preserved rather than rewritten.
   */
  test("replaying an item preserves its member block, ts included", async () => {
    const a = item("chan_a/1");
    const vec = unitVectorAtAngle(1, DIMENSIONS);
    const clock = advancingClock(1000, 500);
    const { repo, deps: d } = repoDeps([], { embeddings: embedderFor([[a, vec]]), clock });

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

  /** §6 L559 — "the mean of a vector with itself is that vector". */
  test("replaying a sole member leaves the embedding unchanged", async () => {
    const a = item("chan_a/1");
    const vec = unitVectorAtAngle(1, DIMENSIONS);
    const clock = advancingClock(1000, 500);
    const { repo, deps: d } = repoDeps([], { embeddings: embedderFor([[a, vec]]), clock });

    const first = await dedupBatch([a], d);
    if (first.writes[0]?.kind !== "create") throw new Error("expected a create");
    await repo.putNew(first.writes[0].message);
    const before = unpackEmbedding((await repo.get("chan_a/1"))?.embedding ?? new Uint8Array());

    const second = await dedupBatch([a], d);
    if (second.writes[0]?.kind !== "merge") throw new Error("expected a merge");
    await repo.mergeMember(second.writes[0].merge);
    const after = unpackEmbedding((await repo.get("chan_a/1"))?.embedding ?? new Uint8Array());

    expect(cosineSimilarity(before, after)).toBe(1);
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
    const a = item("chan_a/1");
    const vec = unitVectorAtAngle(1, DIMENSIONS);
    const { repo, deps: d } = repoDeps([], { embeddings: embedderFor([[a, vec]]) });

    const first = await dedupBatch([a], d);
    if (first.writes[0]?.kind !== "create") throw new Error("expected a create");
    await repo.putNew(first.writes[0].message);

    const second = await dedupBatch([a], d);

    expect(second.toPublish).toEqual([]);
  });
});

describe("metrics", () => {
  test("counts creates and merges separately (§7.7 L689)", async () => {
    const a = item("chan_a/1");
    const b = item("chan_b/2", { body: "second body" });
    await dedupBatch(
      [a, b],
      deps({
        embeddings: embedderFor([
          [a, unitVectorAtAngle(1, DIMENSIONS)],
          [b, unitVectorAtAngle(0.99, DIMENSIONS)],
        ]),
      }),
    );

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
    const replayed = item("chan_a/1");
    const existing = replayable(replayed, { status: "published" });

    const result = await dedupBatch([replayed], replayDeps([existing], [replayed]));

    const [write] = result.writes;
    expect(write?.kind).toBe("merge");
    expect(write?.kind === "merge" ? write.merge.attributes.status : undefined).toBeUndefined();
  });

  test("and is not enqueued for publishing", async () => {
    const replayed = item("chan_a/1");
    const existing = replayable(replayed, { status: "published" });

    const result = await dedupBatch([replayed], replayDeps([existing], [replayed]));

    expect(result.toPublish).toEqual([]);
  });

  /**
   * The other direction, which is E2E-4: a merge that genuinely adds a member
   * must still return the message to `topublish`, or the live post never gains
   * the new member.
   */
  test("a merge that adds a member still republishes", async () => {
    const first = item("chan_a/1");
    const second = item("chan_b/2");
    const existing = replayable(first, { status: "published" });

    const result = await dedupBatch([second], replayDeps([existing], [second]));

    const [write] = result.writes;
    expect(write?.kind === "merge" ? write.merge.attributes.status : undefined).toBe("topublish");
    expect(result.toPublish).toEqual([existing.id]);
  });

  /**
   * A post edited upstream keeps its item id but changes its summary, so the
   * member block differs and the live message must be corrected.
   */
  test("a replayed item whose content changed does republish", async () => {
    const original = item("chan_a/1");
    const existing = replayable(original, { status: "published" });
    const edited = item("chan_a/1", { summary: "summary chan_a/1 (updated)" });

    const result = await dedupBatch([edited], replayDeps([existing], [edited]));

    const [write] = result.writes;
    expect(write?.kind === "merge" ? write.merge.attributes.status : undefined).toBe("topublish");
  });
});
