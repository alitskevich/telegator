# Deduplication Without Embeddings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `aggregate`'s vector deduplication with an entity-anchored Jaccard score that decides clear cases and a Claude adjudicator that resolves an ambiguous band, removing every embedding dependency from the pipeline.

**Architecture:** `analyze` already emits `title`, `peoples`, `properNames`, `location` and `tags` in English, so a match key built from those fields is language-neutral with no embedding. `dedupBatch` builds keys in-process, scores same-date candidates with a weighted Jaccard, auto-merges above `MERGE_THRESHOLD`, auto-splits below `DISTINCT_THRESHOLD`, and sends everything between to Claude in one batched call per invocation. Adjudication failure splits, never merges.

**Tech Stack:** TypeScript, Zod 4, Vitest 4, Biome, AWS CDK, DynamoDB, `@anthropic-ai/bedrock-sdk` (`AnthropicBedrockMantle`).

**Spec:** `docs/superpowers/specs/2026-08-30-dedup-without-embeddings-design.md` — read it before starting. It carries the reasoning, the rejected alternatives, and reconciliations R43–R51.

## Global Constraints

- **All four gates pass before every commit. Not three.** `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.
- **Never weaken a gate:** no `.skip`, no `any`, no `@ts-expect-error`, no lint suppression.
- **`docs/telegator-design.md` is authoritative and MUST NOT be edited.** Divergences are recorded as reconciliations in the comment that makes them, citing section and line, with the reason. This plan's reconciliations are **R43–R51**; the numbers are assigned in the spec's §11 and must be used as assigned.
- **No test touches the network.** Every AWS/Telegram/Bedrock boundary is an interface in a `ports.ts` with an in-memory fake in `test/fakes/`.
- **Relative imports carry no extension.** Write `"../lib/clock"`, never `"../lib/clock.js"`.
- **Zod schemas are the source of truth**; types come from `z.infer`.
- **Biome forbids** `console` outside `scripts/**`, and magic numbers in `lib/`, `handlers/` and `actions/`. Every threshold, weight and cap is a named constant.
- **The dashboard must not reach `lib/pipeline/`** (§8.2 L734), enforced transitively by `test/boundaries.test.ts`. A constant needed by two layers moves to a module neither owns.
- **Item ids are `{sourceId}/{telegramMessageId}`, used verbatim** (§2.4).
- **A source scan that names what it forbids will match itself** — exclude the file, or scan only shipped source.
- **Ordering is additive-first:** new attributes and modules land alongside the embedding machinery, which is deleted only in Task 8. Every task leaves all four gates green.

---

### Task 1: The match key

**Files:**
- Create: `lib/dedup/matchKey.ts`
- Create: `lib/dedup/matchKey.test.ts`
- Modify: `lib/dedup/constants.ts` (add `MATCH_KEY_CAP`)

**Interfaces:**
- Consumes: `AnalyzedItem` from `lib/domain/item`.
- Produces: `MatchKey` (`{ entities: string[]; titleTokens: string[]; tags: string[] }`, every array sorted/deduped/canonical), `buildMatchKey(fields: MatchKeyFields): MatchKey`, `unionMatchKeys(a: MatchKey, b: MatchKey): MatchKey`, `MATCH_KEY_CAP`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/dedup/matchKey.test.ts
import { describe, expect, test } from "vitest";
import { buildMatchKey, unionMatchKeys } from "./matchKey";

describe("buildMatchKey (R46)", () => {
  test("splits comma-separated English entity fields into one sorted set", () => {
    const key = buildMatchKey({
      title: "Minsk Factory Fire",
      peoples: "Ivan Petrov, Maria Ivanova",
      properNames: "Minsk, Belaruskali",
      tags: "fire, industry, safety",
    });

    expect(key.entities).toEqual(["belaruskali", "ivan petrov", "maria ivanova", "minsk"]);
    expect(key.titleTokens).toEqual(["factory", "fire", "minsk"]);
    expect(key.tags).toEqual(["fire", "industry", "safety"]);
  });

  /** AC-3.7 (R51) — replay must serialise byte-identically. */
  test("is canonical: case, spacing, punctuation and order do not change the bytes", () => {
    const a = buildMatchKey({ title: "Minsk  Fire!", properNames: "Minsk, BELARUSKALI" });
    const b = buildMatchKey({ title: "fire minsk", properNames: "belaruskali,  minsk " });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("omits absent fields rather than emitting empty strings", () => {
    const key = buildMatchKey({ title: "Gomel Protest" });

    expect(key.entities).toEqual([]);
    expect(key.tags).toEqual([]);
    expect(key.titleTokens).toEqual(["gomel", "protest"]);
  });
});

describe("unionMatchKeys (R45)", () => {
  test("is the sorted union, replacing the elementwise mean of §3.3", () => {
    const merged = unionMatchKeys(
      buildMatchKey({ properNames: "Minsk", tags: "fire" }),
      buildMatchKey({ properNames: "Gomel", tags: "fire, safety" }),
    );

    expect(merged.entities).toEqual(["gomel", "minsk"]);
    expect(merged.tags).toEqual(["fire", "safety"]);
  });

  test("is commutative, so merge order cannot change the stored bytes", () => {
    const a = buildMatchKey({ properNames: "Minsk, Gomel", title: "Alpha Beta" });
    const b = buildMatchKey({ properNames: "Brest", title: "Beta Gamma" });

    expect(JSON.stringify(unionMatchKeys(a, b))).toBe(JSON.stringify(unionMatchKeys(b, a)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/dedup/matchKey.test.ts`
Expected: FAIL — `Failed to resolve import "./matchKey"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/dedup/matchKey.ts
import { MATCH_KEY_CAP } from "./constants";

/**
 * The deduplication match key (R46), replacing §6 L495-497's embedding.
 *
 * Built only from the fields §5.2 L443-453 makes the classifier emit in English
 * — `title`, `peoples`, `properNames`, `tags`. §5.3's multilingual embedder
 * existed to serve `summary` (Belarusian) and `body` (Russian/Ukrainian), which
 * `buildEmbeddingText` concatenated into the vector and which a match key does
 * not need: the classification has already normalised the discriminating
 * signal into one language.
 *
 * Every array is lowercased, punctuation-stripped, deduplicated and sorted, so
 * an identical item serialises to identical bytes. AC-3.7's byte-identical
 * replay depends on that and on nothing else.
 */
export interface MatchKey {
  readonly entities: readonly string[];
  readonly titleTokens: readonly string[];
  readonly tags: readonly string[];
}

/**
 * A structural shape rather than `AnalyzedItem`, so the §11.3 calibration
 * harness can pass records read from its labelled-set file without building a
 * full queue payload — the reason `EmbeddingTextFields` was structural too.
 */
export interface MatchKeyFields {
  readonly title?: string | undefined;
  readonly peoples?: string | undefined;
  readonly properNames?: string | undefined;
  readonly tags?: string | undefined;
}

/** Punctuation only; letters of any script survive, since `peoples` may not be ASCII. */
const PUNCTUATION = /[^\p{L}\p{N}\s-]/gu;
const WHITESPACE = /\s+/u;

function canonical(value: string): string {
  return value.toLowerCase().replace(PUNCTUATION, "").trim().replace(WHITESPACE, " ");
}

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort().slice(0, MATCH_KEY_CAP);
}

/** `peoples` and `properNames` are comma-separated by §5.2 L451-452. */
function splitCommas(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(",").map(canonical);
}

/** `title` is "three words, English" (§5.2 L443), so whitespace is the separator. */
function splitWords(value: string | undefined): string[] {
  return value === undefined ? [] : canonical(value).split(WHITESPACE);
}

export function buildMatchKey(fields: MatchKeyFields): MatchKey {
  return {
    entities: sortedSet([...splitCommas(fields.peoples), ...splitCommas(fields.properNames)]),
    titleTokens: sortedSet(splitWords(fields.title)),
    tags: sortedSet(splitCommas(fields.tags)),
  };
}

/**
 * R45 — §3.3's merge sets `embedding` to the elementwise mean of the two
 * vectors. With no vector, the union is the equivalent operation: it keeps
 * every discriminating term either input contributed.
 *
 * Commutative and idempotent, which is what lets a replayed merge produce the
 * same bytes as the original (AC-3.7).
 */
export function unionMatchKeys(a: MatchKey, b: MatchKey): MatchKey {
  return {
    entities: sortedSet([...a.entities, ...b.entities]),
    titleTokens: sortedSet([...a.titleTokens, ...b.titleTokens]),
    tags: sortedSet([...a.tags, ...b.tags]),
  };
}
```

Add to `lib/dedup/constants.ts`:

```ts
/**
 * R45 — a storage bound, not a signal filter.
 *
 * Chosen so it is not normally reached: §2.3 L171 caps a message at 20 members,
 * and ~10 terms each is ~200. Capping in lexical order is deterministic, which
 * AC-3.7 requires; capping by term frequency would discriminate better but is
 * not implementable from a union list, because nothing stores per-term counts.
 * Deferred until the cap is observed to bind.
 */
export const MATCH_KEY_CAP = 256;
```

- [ ] **Step 4: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run lib/dedup/matchKey.test.ts && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/dedup/matchKey.ts lib/dedup/matchKey.test.ts lib/dedup/constants.ts
git commit -m "feat(dedup): build a canonical match key from the English fields (R45, R46)"
```

---

### Task 2: The score and the band

**Files:**
- Create: `lib/dedup/score.ts`
- Create: `lib/dedup/score.test.ts`
- Modify: `lib/dedup/constants.ts` (add `SCORE_WEIGHTS`, `MERGE_THRESHOLD`, `DISTINCT_THRESHOLD`)

**Interfaces:**
- Consumes: `MatchKey` from Task 1.
- Produces: `matchScore(a: MatchKey, b: MatchKey, weights?: ScoreWeights): number`, `classify(score: number, band?: Band): "merge" | "adjudicate" | "distinct"`, `ScoreWeights`, `Band`, `SCORE_WEIGHTS`, `MERGE_THRESHOLD`, `DISTINCT_THRESHOLD`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/dedup/score.test.ts
import { describe, expect, test } from "vitest";
import { buildMatchKey } from "./matchKey";
import { classify, matchScore } from "./score";

const key = (fields: Parameters<typeof buildMatchKey>[0]) => buildMatchKey(fields);

describe("matchScore (R46)", () => {
  test("scores an identical key at 1", () => {
    const a = key({ title: "Minsk Factory Fire", properNames: "Minsk", tags: "fire" });

    expect(matchScore(a, a)).toBeCloseTo(1);
  });

  test("scores disjoint keys at 0", () => {
    const a = key({ title: "Minsk Factory Fire", properNames: "Minsk", tags: "fire" });
    const b = key({ title: "Brest Border Queue", properNames: "Brest", tags: "transport" });

    expect(matchScore(a, b)).toBe(0);
  });

  /**
   * The trap. `|a n b| / |a u b|` is 0/0 for two empty sets, and any reading
   * that treats that as equality auto-merges every sparse pair — two items with
   * no entities would score 1 on the heaviest-weighted component.
   */
  test("scores two entity-less items on evidence, never on shared emptiness", () => {
    const a = key({ title: "Alpha Beta" });
    const b = key({ title: "Gamma Delta" });

    expect(matchScore(a, b)).toBe(0);
  });

  test("weights entities above title above tags", () => {
    const base = key({ title: "Alpha Beta", properNames: "Minsk", tags: "fire" });
    const sharedEntity = key({ title: "Gamma Delta", properNames: "Minsk", tags: "safety" });
    const sharedTag = key({ title: "Gamma Delta", properNames: "Brest", tags: "fire" });

    expect(matchScore(base, sharedEntity)).toBeGreaterThan(matchScore(base, sharedTag));
  });

  test("is symmetric, so candidate ordering cannot change a verdict", () => {
    const a = key({ title: "Minsk Fire", properNames: "Minsk, Belaruskali", tags: "fire" });
    const b = key({ title: "Minsk Blaze", properNames: "Minsk", tags: "fire, safety" });

    expect(matchScore(a, b)).toBe(matchScore(b, a));
  });
});

describe("classify", () => {
  test("auto-merges at or above the merge threshold", () => {
    expect(classify(1, { merge: 0.72, distinct: 0.35 })).toBe("merge");
    expect(classify(0.72, { merge: 0.72, distinct: 0.35 })).toBe("merge");
  });

  test("auto-splits at or below the distinct threshold", () => {
    expect(classify(0, { merge: 0.72, distinct: 0.35 })).toBe("distinct");
    expect(classify(0.35, { merge: 0.72, distinct: 0.35 })).toBe("distinct");
  });

  test("sends the band to the adjudicator", () => {
    expect(classify(0.5, { merge: 0.72, distinct: 0.35 })).toBe("adjudicate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/dedup/score.test.ts`
Expected: FAIL — `Failed to resolve import "./score"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/dedup/score.ts
import { DISTINCT_THRESHOLD, MERGE_THRESHOLD, SCORE_WEIGHTS } from "./constants";
import type { MatchKey } from "./matchKey";

export interface ScoreWeights {
  readonly entities: number;
  readonly titleTokens: number;
  readonly tags: number;
}

export interface Band {
  readonly merge: number;
  readonly distinct: number;
}

export type Verdict = "merge" | "adjudicate" | "distinct";

/**
 * Jaccard, with the empty-empty case defined as 0 rather than left as 0/0.
 *
 * Two items that both lack entities have produced no evidence, not agreement.
 * Returning 1 there would auto-merge every sparse pair on the
 * heaviest-weighted component — a false merge, which §11.3 L868 ranks as the
 * costlier error.
 */
function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;

  const left = new Set(a);
  let shared = 0;
  for (const value of new Set(b)) {
    if (left.has(value)) shared += 1;
  }

  const union = left.size + new Set(b).size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * R46 — the replacement for §6 L508's cosine similarity.
 *
 * Weighted because the three components are not equally discriminating: two
 * reports of one event nearly always share a proper name or a person, often
 * share a title token once §5.2 L443 has reduced the title to three English
 * words, and share tags only loosely because L453 asks for "3-5 related tags"
 * rather than a controlled vocabulary.
 */
export function matchScore(a: MatchKey, b: MatchKey, weights: ScoreWeights = SCORE_WEIGHTS): number {
  return (
    weights.entities * jaccard(a.entities, b.entities) +
    weights.titleTokens * jaccard(a.titleTokens, b.titleTokens) +
    weights.tags * jaccard(a.tags, b.tags)
  );
}

/** The two-threshold band of R46. Both bounds are inclusive on the auto side. */
export function classify(
  score: number,
  band: Band = { merge: MERGE_THRESHOLD, distinct: DISTINCT_THRESHOLD },
): Verdict {
  if (score >= band.merge) return "merge";
  if (score <= band.distinct) return "distinct";
  return "adjudicate";
}
```

Add to `lib/dedup/constants.ts`:

```ts
/**
 * R46. **Provisional**, exactly as `SIMILARITY_THRESHOLD` was: §11.3 (as
 * rewritten by R48) forbids publishing to production channels until these are
 * swept against the labelled set, and `cdk synth -c env=prod` refuses until the
 * result is recorded in `calibration/record.json`.
 *
 * Injected rather than read at the comparison site, so recalibration stays a
 * configuration change rather than a code edit.
 */
export const MERGE_THRESHOLD = 0.72;
export const DISTINCT_THRESHOLD = 0.35;

/**
 * R46. Fixed rather than swept: five continuous parameters fitted to §11.3's
 * ~100 labelled pairs would overfit and produce a curve that means nothing.
 * §11.3 sweeps the two thresholds and takes weights from a coarse grid.
 */
export const SCORE_WEIGHTS = { entities: 0.6, titleTokens: 0.25, tags: 0.15 } as const;
```

- [ ] **Step 4: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run lib/dedup/score.test.ts && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/dedup/score.ts lib/dedup/score.test.ts lib/dedup/constants.ts
git commit -m "feat(dedup): weighted Jaccard score with a two-threshold band (R46)"
```

---

### Task 3: The adjudicator port

**Files:**
- Create: `lib/ai/adjudicator.ts`
- Create: `lib/ai/adjudicator.test.ts`
- Modify: `lib/ai/ports.ts` (add `Adjudicator`)
- Modify: `lib/ai/constants.ts` (add `ADJUDICATOR_MODEL_ID`)
- Modify: `test/fakes/ai.ts` (add `fakeAdjudicator`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Adjudicator`, `AdjudicationPair`, `AdjudicationFields` (all three in `lib/ai/ports.ts`), `createBedrockAdjudicator(options?)`, `parseVerdicts(response: unknown, expected: readonly string[]): ReadonlyMap<string, boolean>`, `fakeAdjudicator(...)`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/ai/adjudicator.test.ts
import { describe, expect, test } from "vitest";
import { parseVerdicts } from "./adjudicator";

const response = (verdicts: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ verdicts }) }] });

describe("parseVerdicts (R46)", () => {
  test("keys verdicts by pair id", () => {
    const parsed = parseVerdicts(
      response([
        { id: "a", same: true },
        { id: "b", same: false },
      ]),
      ["a", "b"],
    );

    expect(parsed.get("a")).toBe(true);
    expect(parsed.get("b")).toBe(false);
  });

  /**
   * `parseEmbeddings` checks its returned count because §6 indexed
   * `embeddings[idx]` against `batch[idx]`, and a short response would silently
   * attach the wrong vector to every later item. A model that answers two of
   * three pairs reintroduces exactly that, so an incomplete verdict set is an
   * error rather than a partial result.
   */
  test("rejects a verdict set that does not cover every requested pair", () => {
    expect(() => parseVerdicts(response([{ id: "a", same: true }]), ["a", "b"])).toThrow(
      /verdict/i,
    );
  });

  test("rejects a verdict for a pair that was never sent", () => {
    expect(() =>
      parseVerdicts(response([{ id: "a", same: true }, { id: "z", same: true }]), ["a"]),
    ).toThrow(/verdict/i);
  });

  test("rejects a duplicated pair id rather than letting the last one win", () => {
    expect(() =>
      parseVerdicts(response([{ id: "a", same: true }, { id: "a", same: false }]), ["a"]),
    ).toThrow(/verdict/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/ai/adjudicator.test.ts`
Expected: FAIL — `Failed to resolve import "./adjudicator"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/ai/adjudicator.ts
import { z } from "zod";
import { ADJUDICATOR_MAX_TOKENS, ADJUDICATOR_MODEL_ID } from "./constants";
import type { Adjudicator } from "./ports";

const VerdictsSchema = z.object({
  verdicts: z.array(z.object({ id: z.string().min(1), same: z.boolean() })),
});

/** Sent as `output_config.format.schema`, generated rather than hand-written (§5.2 L423). */
export const VERDICTS_SCHEMA = z.toJSONSchema(VerdictsSchema);

function extractText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response)) {
    throw new Error("adjudicator returned no Messages content block");
  }
  const { content } = response as { content: unknown };
  if (!Array.isArray(content)) throw new Error("adjudicator returned a non-array content field");

  const text = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: unknown }).type === "text" &&
        typeof (block as { text: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");

  if (text === "") throw new Error("adjudicator returned no text content");
  return text;
}

/**
 * Verdicts must cover the requested ids exactly — no gaps, no strangers, no
 * duplicates. A partial answer is an error, not a partial result: silently
 * defaulting the missing pairs would decide real merges by omission.
 */
export function parseVerdicts(
  response: unknown,
  expected: readonly string[],
): ReadonlyMap<string, boolean> {
  const { verdicts } = VerdictsSchema.parse(JSON.parse(extractText(response)));

  const byId = new Map<string, boolean>();
  for (const verdict of verdicts) {
    if (byId.has(verdict.id)) throw new Error(`duplicate verdict for pair ${verdict.id}`);
    byId.set(verdict.id, verdict.same);
  }

  const wanted = new Set(expected);
  for (const id of byId.keys()) {
    if (!wanted.has(id)) throw new Error(`verdict for unknown pair ${id}`);
  }
  for (const id of wanted) {
    if (!byId.has(id)) throw new Error(`missing verdict for pair ${id}`);
  }

  return byId;
}

export interface AdjudicatorClient {
  create(request: unknown): Promise<unknown>;
}

export interface BedrockAdjudicatorOptions {
  readonly client?: AdjudicatorClient;
}

const SYSTEM_PROMPT =
  "You decide whether two news reports describe the same underlying event. " +
  "Two reports of one event may use different wording, different sources and " +
  "different emphasis. Different events that merely share a place, a person or " +
  "a topic are NOT the same event. Answer for every pair you are given.";

export function createBedrockAdjudicator(options: BedrockAdjudicatorOptions = {}): Adjudicator {
  let client = options.client;

  return {
    adjudicate: async (pairs) => {
      if (pairs.length === 0) return new Map();

      if (client === undefined) {
        const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
        const mantle = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION });
        client = { create: (request) => mantle.messages.create(request as never) };
      }

      const response = await client.create({
        model: ADJUDICATOR_MODEL_ID,
        max_tokens: ADJUDICATOR_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: VERDICTS_SCHEMA } },
        messages: [{ role: "user", content: JSON.stringify({ pairs }) }],
      });

      return parseVerdicts(
        response,
        pairs.map((pair) => pair.id),
      );
    },
  };
}
```

Add to `lib/ai/ports.ts`. The pair types live **here, not in `adjudicator.ts`** — the
adapter imports the port, so defining them the other way round would make the two
modules import each other:

```ts
/**
 * R46 — the band adjudicator's inputs.
 *
 * Only the English structured fields cross this boundary. `body` (Russian or
 * Ukrainian) and `summary` (Belarusian) are deliberately excluded: §5.2 has
 * already reduced the discriminating signal to one language, and sending source
 * text back to a model would make the call large, slow and language-dependent
 * for no gain.
 */
export interface AdjudicationFields {
  readonly title: string;
  readonly entities: readonly string[];
  readonly tags: readonly string[];
  readonly category: string | undefined;
  readonly location: string | undefined;
  readonly date: string;
}

export interface AdjudicationPair {
  /** Caller-assigned and stable. Verdicts come back keyed by this, never positionally. */
  readonly id: string;
  readonly item: AdjudicationFields;
  readonly candidate: AdjudicationFields;
}

/**
 * One call per aggregate batch, carrying at most one pair per item, because
 * only each item's highest-scoring candidate is ever ambiguous.
 *
 * Returns a map keyed by `AdjudicationPair.id`. Never an array: §6 indexed one
 * provider response positionally against its input, and `parseEmbeddings`
 * exists to catch what that cost.
 */
export interface Adjudicator {
  adjudicate(pairs: readonly AdjudicationPair[]): Promise<ReadonlyMap<string, boolean>>;
}
```

Add to `lib/ai/constants.ts`:

```ts
/**
 * R46. Its own constant, defaulting to the classifier's tier, so the two tasks
 * can diverge later without reopening R2's §5.1-versus-§12.1 disagreement.
 */
export const ADJUDICATOR_MODEL_ID = CLASSIFIER_MODEL_ID;

/** R46 — a verdict list for at most 10 pairs is far smaller than a classification. */
export const ADJUDICATOR_MAX_TOKENS = 1000;
```

Add to `test/fakes/ai.ts`:

```ts
import type { AdjudicationPair, Adjudicator } from "../../lib/ai/ports";

/**
 * Decides by a caller-supplied predicate, and records what it was asked.
 * `calls` is what lets a test assert the band produced ONE call for the batch
 * rather than one per pair.
 */
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

/** Throws, to drive R46's "adjudication failure splits" path. */
export function failingAdjudicator(message = "adjudicator unavailable"): Adjudicator {
  return {
    adjudicate: async () => {
      throw new Error(message);
    },
  };
}
```

- [ ] **Step 4: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run lib/ai/adjudicator.test.ts && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass. If `z.toJSONSchema` rejects the schema, check the installed Zod major version — Zod 4 emits JSON Schema natively and is what `NEWS_ITEM_SCHEMA` already uses.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/adjudicator.ts lib/ai/adjudicator.test.ts lib/ai/ports.ts lib/ai/constants.ts test/fakes/ai.ts
git commit -m "feat(ai): add the band adjudicator port with id-keyed verdicts (R46)"
```

---
### Task 4: Storage — match key attributes alongside the embedding

Additive: `embedding` stays and keeps working. Nothing is deleted until Task 8, so all four gates stay green throughout.

**Files:**
- Modify: `lib/domain/message.ts` (add fields to `messageFields`, `DedupCandidateSchema`, `MessageMergeAttributesSchema`)
- Modify: `lib/db/messages.ts` (persist the new attributes; locate sites with `grep -n "embedding" lib/db/messages.ts`)
- Modify: `lib/domain/message.test.ts`, `lib/db/messages.test.ts`
- Modify: `infra/lib/data-stack.ts:52` (`DEDUP_CANDIDATE_ATTRIBUTES`)
- Modify: `infra/lib/data-stack.test.ts`

**Interfaces:**
- Consumes: `MatchKey` from Task 1.
- Produces: `Message.keyEntities`/`keyTitle`/`keyTags`/`memberIds` (all `string[]`, defaulting to `[]`), the same four on `DedupCandidate`, and `matchKeyOf(message)` / `matchKeyAttributes(key)` helpers in `lib/domain/message.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/domain/message.test.ts — add
import { DedupCandidateSchema, matchKeyAttributes, matchKeyOf } from "./message";
import { buildMatchKey } from "../dedup/matchKey";

describe("the match key attributes (R44)", () => {
  test("a candidate carries its key and its member ids", () => {
    const candidate = DedupCandidateSchema.parse({
      id: "src/1",
      date: "2026-08-30",
      ts: 1,
      keyEntities: ["minsk"],
      keyTitle: ["fire"],
      keyTags: ["safety"],
      memberIds: ["src/1", "src/2"],
    });

    expect(matchKeyOf(candidate)).toEqual({
      entities: ["minsk"],
      titleTokens: ["fire"],
      tags: ["safety"],
    });
    expect(candidate.memberIds).toEqual(["src/1", "src/2"]);
  });

  test("a record written before R44 reads as an empty key, so it can never match", () => {
    const legacy = DedupCandidateSchema.parse({ id: "src/1", date: "2026-08-30", ts: 1 });

    expect(matchKeyOf(legacy)).toEqual({ entities: [], titleTokens: [], tags: [] });
    expect(legacy.memberIds).toEqual([]);
  });

  test("round-trips a built key without reordering it", () => {
    const key = buildMatchKey({ properNames: "Minsk, Gomel", title: "Factory Fire" });

    expect(matchKeyOf(DedupCandidateSchema.parse({
      id: "src/1", date: "2026-08-30", ts: 1, ...matchKeyAttributes(key),
    }))).toEqual(key);
  });
});
```

```ts
// infra/lib/data-stack.test.ts — add
test("date-index projects the match key and member ids, not the embedding (R44)", () => {
  const template = templateFor();

  template.hasResourceProperties("AWS::DynamoDB::Table", {
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: "date-index",
        Projection: Match.objectLike({
          NonKeyAttributes: Match.arrayWith(["keyEntities", "keyTitle", "keyTags", "memberIds"]),
        }),
      }),
    ]),
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/domain/message.test.ts infra/lib/data-stack.test.ts`
Expected: FAIL — `matchKeyOf` is not exported; `NonKeyAttributes` does not contain the new names.

- [ ] **Step 3: Implement**

In `lib/domain/message.ts`, add to `messageFields` (beside `embedding`, which stays until Task 8):

```ts
  /**
   * R44 — §7.2 L590 stores a 1024-float embedding as 4 KB of Binary. With no
   * vector, the match key of R46 takes its place: three short string lists,
   * a few hundred bytes, and readable in the console.
   *
   * Defaulted rather than optional so a record written before R44 parses as an
   * empty key. An empty key scores 0 against everything (`jaccard` defines
   * empty-versus-empty as 0), so such a record simply never matches and ages
   * out of `date-index` — which is the whole of the migration story.
   */
  keyEntities: z.array(z.string()).default([]),
  keyTitle: z.array(z.string()).default([]),
  keyTags: z.array(z.string()).default([]),
  /**
   * R51 — the ids already in `members`, projected so AC-3.7's replay check
   * costs nothing.
   *
   * An item that CREATED a message is addressable as `loadMessage(item.id)`,
   * because §3.3's create branch sets `id` = item id. An item that MERGED is
   * not: its id lives only inside another message's `members` map, and R9
   * records that `date-index` projects no `members`. Without this attribute the
   * short-circuit would need a base-table read per candidate.
   */
  memberIds: z.array(z.string()).default([]),
```

Add both to `DedupCandidateSchema`'s `.pick({...})` and to `MessageMergeAttributesSchema`, then:

```ts
/** R44 — the stored attributes, as the `MatchKey` the scorer consumes. */
export function matchKeyOf(record: {
  readonly keyEntities: readonly string[];
  readonly keyTitle: readonly string[];
  readonly keyTags: readonly string[];
}): MatchKey {
  return { entities: record.keyEntities, titleTokens: record.keyTitle, tags: record.keyTags };
}

/** The inverse, for a write. */
export function matchKeyAttributes(key: MatchKey): {
  keyEntities: string[];
  keyTitle: string[];
  keyTags: string[];
} {
  return {
    keyEntities: [...key.entities],
    keyTitle: [...key.titleTokens],
    keyTags: [...key.tags],
  };
}
```

In `infra/lib/data-stack.ts`, replace `DEDUP_CANDIDATE_ATTRIBUTES` and its comment:

```ts
/**
 * The `date-index` projection (§7.2 L598, R27, amended by R44/R51).
 *
 * §7.2 L598 calls this "the one query that needs vectors". There are no vectors
 * now: it needs the match key R46 scores on, plus the member ids R51's replay
 * short-circuit checks. Everything the merge needs beyond that still comes from
 * the base-table read of R9.
 */
const DEDUP_CANDIDATE_ATTRIBUTES = [
  "keyEntities",
  "keyTitle",
  "keyTags",
  "memberIds",
  "deleted",
] as const;
```

In `lib/db/messages.ts`, write the four attributes wherever `embedding` is written today (`grep -n "embedding" lib/db/messages.ts`), and include them in the merge's attribute-level update.

- [ ] **Step 4: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass. A `date-index` projection change is an in-place GSI update; `cdk diff` will show it as a modification, not a replacement.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/message.ts lib/domain/message.test.ts lib/db/messages.ts lib/db/messages.test.ts infra/lib/data-stack.ts infra/lib/data-stack.test.ts
git commit -m "feat(db): store the match key and member ids on messages (R44, R51)"
```

---

### Task 5: Rewrite `dedupBatch`

The core of the change. Read `lib/dedup/dedupBatch.ts` in full before starting — R7–R11 are implemented there and every one of them must survive.

**Files:**
- Modify: `lib/dedup/dedupBatch.ts`
- Modify: `lib/dedup/dedupBatch.test.ts`

**Interfaces:**
- Consumes: `buildMatchKey`/`unionMatchKeys` (Task 1), `matchScore`/`classify` (Task 2), `Adjudicator`/`AdjudicationPair` (Task 3), `matchKeyOf`/`matchKeyAttributes` (Task 4).
- Produces: `DedupDeps.adjudicator` replacing `DedupDeps.embeddings`; `DedupDeps.band?: Band` replacing `DedupDeps.similarityThreshold`. `dedupBatch`'s signature and `DedupResult` are otherwise unchanged.

- [ ] **Step 1: Define the fixtures the new tests need**

`lib/dedup/dedupBatch.test.ts` already has builders for items, candidates and
deps — read the top of the file and reuse them. These four are new, and every
test in Step 2 depends on them, so write them first. The scores are what put
each pair in a specific region of the band, so they are chosen against
`SCORE_WEIGHTS`, not arbitrary:

```ts
// lib/dedup/dedupBatch.test.ts — add near the existing builders
import { DISTINCT_THRESHOLD, MERGE_THRESHOLD } from "./constants";
import { buildMatchKey } from "./matchKey";
import { matchScore } from "./score";

const DATE = "2026-08-30";

/** Identical entities, title and tags -> score 1, comfortably above merge. */
const twoNearIdenticalItems = () => [
  itemWith({ id: "src/1", date: DATE, title: "Minsk Factory Fire", properNames: "Minsk, Belaruskali", tags: "fire, safety" }),
  itemWith({ id: "src/2", date: DATE, title: "Minsk Factory Fire", properNames: "Minsk, Belaruskali", tags: "fire, safety" }),
];

/** No shared term anywhere -> score 0, at or below distinct. */
const twoUnrelatedItems = () => [
  itemWith({ id: "src/1", date: DATE, title: "Minsk Factory Fire", properNames: "Minsk", tags: "fire" }),
  itemWith({ id: "src/2", date: DATE, title: "Brest Border Queue", properNames: "Brest", tags: "transport" }),
];

/** One shared entity of two, disjoint titles, one shared tag of two -> mid-band. */
const twoAmbiguousItems = () => [
  itemWith({ id: "src/1", date: DATE, title: "Alpha Beta", properNames: "Minsk, Belaruskali", tags: "fire, safety" }),
  itemWith({ id: "src/2", date: DATE, title: "Gamma Delta", properNames: "Minsk, Naftan", tags: "fire, industry" }),
];

const threeAmbiguousItems = () => [
  ...twoAmbiguousItems(),
  itemWith({ id: "src/3", date: DATE, title: "Epsilon Zeta", properNames: "Minsk, Grodno", tags: "fire, transport" }),
];

/**
 * Guards the fixtures themselves. If a weight or a threshold moves, these fail
 * loudly here rather than silently turning every band test into a merge test
 * that passes for the wrong reason.
 */
test("the fixtures sit where the band tests assume", () => {
  const score = (items: ReturnType<typeof twoAmbiguousItems>) =>
    matchScore(buildMatchKey(items[0]), buildMatchKey(items[1]));

  expect(score(twoNearIdenticalItems())).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
  expect(score(twoUnrelatedItems())).toBeLessThanOrEqual(DISTINCT_THRESHOLD);
  expect(score(twoAmbiguousItems())).toBeGreaterThan(DISTINCT_THRESHOLD);
  expect(score(twoAmbiguousItems())).toBeLessThan(MERGE_THRESHOLD);
});
```

If that guard fails, adjust the **fixtures** until they land in the intended
region. Do not adjust `MERGE_THRESHOLD` or `DISTINCT_THRESHOLD` to accommodate a
fixture — those are §11.3's to set, and Task 9's sweep is what sets them.

`candidateWith` must accept `memberIds`; extend the existing builder if it does
not. `fakeMetrics` is the existing fake in `test/fakes/metrics.ts` — check the
accessor's real name (`grep -n "export" test/fakes/metrics.ts`) and use it
instead of the `counts(...)` shown below if it differs.

- [ ] **Step 2: Write the failing tests**

```ts
// lib/dedup/dedupBatch.test.ts — add
import { failingAdjudicator, fakeAdjudicator } from "../../test/fakes/ai";

describe("the band (R46)", () => {
  test("auto-merges above the merge threshold without calling the model", async () => {
    const adjudicator = fakeAdjudicator(() => false);
    const result = await dedupBatch(twoNearIdenticalItems(), depsWith({ adjudicator }));

    expect(adjudicator.calls).toHaveLength(0);
    expect(result.writes).toHaveLength(1);
  });

  test("auto-splits below the distinct threshold without calling the model", async () => {
    const adjudicator = fakeAdjudicator(() => true);
    const result = await dedupBatch(twoUnrelatedItems(), depsWith({ adjudicator }));

    expect(adjudicator.calls).toHaveLength(0);
    expect(result.writes).toHaveLength(2);
  });

  test("adjudicates the band in ONE call for the whole batch", async () => {
    const adjudicator = fakeAdjudicator(() => true);
    await dedupBatch(threeAmbiguousItems(), depsWith({ adjudicator }));

    expect(adjudicator.calls).toHaveLength(1);
  });

  test("a 'same' verdict merges and a 'different' verdict splits", async () => {
    const merged = await dedupBatch(twoAmbiguousItems(), depsWith({ adjudicator: fakeAdjudicator(() => true) }));
    const split = await dedupBatch(twoAmbiguousItems(), depsWith({ adjudicator: fakeAdjudicator(() => false) }));

    expect(merged.writes).toHaveLength(1);
    expect(split.writes).toHaveLength(2);
  });

  /** §11.3 L868 — "False merges are worse than false splits." */
  test("a failing adjudication splits rather than merging", async () => {
    const metrics = fakeMetrics();
    const result = await dedupBatch(
      twoAmbiguousItems(),
      depsWith({ adjudicator: failingAdjudicator(), metrics }),
    );

    expect(result.writes).toHaveLength(2);
    expect(metrics.counts("DedupAdjudicationFailed")).toBe(1);
  });
});

describe("the replay short-circuit (R51, AC-3.7)", () => {
  test("an item already in a candidate's memberIds merges there with no scoring", async () => {
    const adjudicator = fakeAdjudicator(() => false);
    const deps = depsWith({
      adjudicator,
      candidates: [candidateWith({ id: "src/1", memberIds: ["src/1", "src/9"], date: "2026-08-30" })],
    });

    const result = await dedupBatch([itemWith({ id: "src/9", date: "2026-08-30" })], deps);

    expect(adjudicator.calls).toHaveLength(0);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]?.id).toBe("src/1");
  });
});

describe("the merged key (R45, AC-3.6)", () => {
  test("a merged message's key is the sorted union of the inputs", async () => {
    const result = await dedupBatch(twoNearIdenticalItems(), depsWith({ adjudicator: fakeAdjudicator(() => true) }));

    expect(result.writes[0]?.keyEntities).toEqual([...new Set(result.writes[0]?.keyEntities)].sort());
  });
});
```

Reuse the file's existing item/candidate/deps builders; add `depsWith` if the file does not already have an equivalent.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/dedup/dedupBatch.test.ts`
Expected: FAIL — `deps.adjudicator` is not a property of `DedupDeps`.

- [ ] **Step 4: Implement**

Replace the embedding call and both comparison passes. The order inside `dedupBatch` becomes:

1. **Short-circuit.** Load same-date candidates once (the existing `candidatesByDate` cache). For each item, if any candidate's `memberIds` includes `item.id`, merge into that candidate and skip scoring entirely.
2. **Keys.** `const keys = batch.map(buildMatchKey)` — pure, replacing `await deps.embeddings.embedBatch(...)`.
3. **Pass 1** (local, §6 L505-511) and **Pass 2** (stored, §6 L515, R9/R10 unchanged): score with `matchScore(keys[index], matchKeyOf(candidate))`, keep the single highest.
4. **Classify** the best score per item with `classify(score, deps.band)`. `merge` and `distinct` resolve immediately; `adjudicate` pushes an `AdjudicationPair` onto a list, keyed `` `${item.id}->${candidate.id}` ``.
5. **One call.** If the list is non-empty, `await deps.adjudicator.adjudicate(pairs)` inside a `try`. On throw: log, `deps.metrics.count("DedupAdjudicationFailed")`, and treat **every** pending pair as `distinct`. On success: `deps.metrics.count("DedupAdjudicated", pairs.length)`.
6. **Apply** verdicts, then create/merge exactly as today, with `unionMatchKeys` where the code currently calls `elementwiseMean`, and `matchKeyAttributes(...)` on the write.

Update the `DedupDeps` doc comment: `similarityThreshold` becomes `band?: Band`, keeping its "injected so §11.3's recalibration is a configuration change, not a code edit" rationale, and citing R46/R48.

Keep R7, R8, R9, R10 and R11 exactly as they are. R11 in particular — an existing member keeps its original `ts` — is what AC-3.7 needs alongside the new short-circuit.

- [ ] **Step 5: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/dedup/dedupBatch.ts lib/dedup/dedupBatch.test.ts
git commit -m "feat(dedup): score-and-adjudicate matching, replacing cosine similarity (R45, R46, R51)"
```

---

### Task 6: Wire the aggregate stage

**Files:**
- Modify: `lib/pipeline/aggregate/index.ts`
- Modify: `handlers/aggregate.ts`
- Modify: `lib/metrics/ports.ts` (add two counters)
- Modify: the corresponding `.test.ts` files

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `METRIC_NAMES` gains `"DedupAdjudicated"` and `"DedupAdjudicationFailed"`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/metrics/ports.test.ts — add
test("counts adjudication volume and failure (R50)", () => {
  expect(METRIC_NAMES).toContain("DedupAdjudicated");
  expect(METRIC_NAMES).toContain("DedupAdjudicationFailed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/metrics/ports.test.ts`
Expected: FAIL — the names are absent.

- [ ] **Step 3: Implement**

Add to `METRIC_NAMES`, keeping the file's table-order convention and its comment style:

```ts
  "DedupAdjudicated", // aggregate, R50 — band pairs sent to the model
  "DedupAdjudicationFailed", // aggregate, R50 — failures, which split (§11.3 L868)
```

Note in a comment that §7.7 L684-693's table does not list these (R50): they exist because the band is a cost centre and a silent failure mode, and §7.7 L679 makes CloudWatch the system of record for volume.

In `handlers/aggregate.ts`, replace the embedding provider in `buildDeps()` with `adjudicator: createBedrockAdjudicator()`. In `lib/pipeline/aggregate/index.ts`, thread `adjudicator` through wherever `embeddings` is threaded today.

- [ ] **Step 4: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics/ports.ts lib/metrics/ports.test.ts lib/pipeline/aggregate/index.ts handlers/aggregate.ts lib/pipeline/aggregate/index.test.ts handlers/aggregate.test.ts
git commit -m "feat(aggregate): build the adjudicator and count band volume (R50)"
```

---

### Task 7: IAM — one Bedrock grant for the whole stack

**Files:**
- Modify: `infra/lib/pipeline-stack.ts` (delete `invokeModel`, grant `createInference()` to aggregate)
- Modify: `infra/lib/pipeline-events.test.ts`

**Interfaces:**
- Consumes: `createInference()`, added by R42.
- Produces: no `bedrock:InvokeModel` statement anywhere in the synthesised template.

- [ ] **Step 1: Write the failing test**

Replace the Bedrock grant tests with:

```ts
  /**
   * R49 — aggregate embedded through `bedrock-runtime`, so §7.6 L670's
   * `bedrock:InvokeModel` was correct for it while R42 was fixing analyze's.
   * With embeddings gone (R43) both stages call the Mantle API, so one grant
   * covers the stack and `bedrock:InvokeModel` appears nowhere.
   */
  test("grants bedrock-mantle:CreateInference to exactly two functions, and InvokeModel to none", () => {
    const statements = policyStatements(templateFor());

    const mantle = statements.filter((s) =>
      [s.Action].flat().map(String).includes("bedrock-mantle:CreateInference"),
    );
    const invoke = statements.filter((s) =>
      [s.Action].flat().map(String).includes("bedrock:InvokeModel"),
    );

    expect(mantle).toHaveLength(2);
    expect(invoke).toHaveLength(0);
    for (const statement of mantle) {
      expect(statement.Resource).not.toBe("*");
    }
  });

  test("aggregate may create a Mantle inference", () => {
    expect(bedrockFor(templateFor(), "telegator-dev-aggregate")).toContain(
      `project/${MANTLE_PROJECT_ID}`,
    );
  });
```

Delete the now-meaningless assertions that reference `EMBEDDING_MODEL_ID` and `foundation-model`, and drop `CLASSIFIER_MODEL_ID`/`EMBEDDING_MODEL_ID` from the file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run infra/lib/pipeline-events.test.ts`
Expected: FAIL — one `bedrock:InvokeModel` statement remains (aggregate's).

- [ ] **Step 3: Implement**

In `infra/lib/pipeline-stack.ts`: change `aggregate.addToRolePolicy(invokeModel(EMBEDDING_MODEL_ID))` to `aggregate.addToRolePolicy(createInference())`, delete the `invokeModel` function and its comment, and drop `EMBEDDING_MODEL_ID` and `Aws`-only-for-that-purpose imports if now unused. Extend `createInference`'s comment to record R49.

- [ ] **Step 4: Run the four gates, and read the diff**

```bash
npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth > /dev/null
npx cdk diff TelegatorPipelineStack -c reserveConcurrency=false
```
Expected: gates pass; the diff shows aggregate's statement swapped and no other IAM change. **`-c reserveConcurrency=false` matters** — without it the deploy would also add `ReservedConcurrentExecutions` to three functions (R40), which is a separate change that must not ride along.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/pipeline-stack.ts infra/lib/pipeline-events.test.ts
git commit -m "feat(infra): one bedrock-mantle grant for both model callers (R49)"
```

---

### Task 8: Delete the embedding machinery

Nothing references it after Tasks 5–7. Deleting earlier would have broken the build; deleting later would leave dead code the boundary tests still scan.

**Files:**
- Delete: `lib/dedup/cosine.ts`, `lib/dedup/cosine.test.ts`, `lib/dedup/vectors.ts`, `lib/dedup/vectors.test.ts`, `lib/dedup/embeddingText.ts`, `lib/dedup/embeddingText.test.ts`, `lib/db/embeddingCodec.ts`, `lib/db/embeddingCodec.test.ts`
- Modify: `lib/ai/ports.ts` (remove `EmbeddingProvider`), `lib/ai/bedrock.ts` (remove `createBedrockEmbeddingProvider`, `BedrockInvoker`, `BedrockInvokeResponse`, `parseEmbeddings`, the `@aws-sdk/client-bedrock-runtime` import), `lib/ai/bedrock.test.ts`, `lib/ai/constants.ts` (remove the three `EMBEDDING_*` constants), `lib/ai/constants.test.ts`, `lib/dedup/constants.ts` (remove `DIMENSIONS`, `EMBEDDING_BYTE_LENGTH`, `SIMILARITY_THRESHOLD`), `lib/dedup/constants.test.ts`, `lib/domain/message.ts` (remove the `embedding` field), `package.json` (drop `@aws-sdk/client-bedrock-runtime` if nothing else imports it)

- [ ] **Step 1: Prove nothing still references them**

```bash
grep -rn "EmbeddingProvider\|embedBatch\|cosineSimilarity\|elementwiseMean\|buildEmbeddingText\|packEmbedding\|unpackEmbedding\|EMBEDDING_MODEL_ID\|EMBEDDING_INPUT_TYPE\|EMBEDDING_MAX_BATCH\|DIMENSIONS\|EMBEDDING_BYTE_LENGTH\|SIMILARITY_THRESHOLD" --include='*.ts' --include='*.tsx' . | grep -v node_modules
```
Expected: only the files listed above, plus `lib/metrics/cloudwatch.ts`'s unrelated `ALLOWED_DIMENSIONS` — leave that alone, it is CloudWatch metric dimensions, not vector width.

- [ ] **Step 2: Delete and prune**

```bash
git rm lib/dedup/cosine.ts lib/dedup/cosine.test.ts lib/dedup/vectors.ts lib/dedup/vectors.test.ts lib/dedup/embeddingText.ts lib/dedup/embeddingText.test.ts lib/db/embeddingCodec.ts lib/db/embeddingCodec.test.ts
```

Then remove the symbols listed above by hand. In `lib/domain/message.ts`, delete the `embedding` field and record R43 in its place:

```ts
  // R43 — §7.2 L590's 4 KB embedding Binary is gone; `keyEntities`/`keyTitle`/
  // `keyTags` (R44) carry what dedup compares. Existing rows keep an orphan
  // `embedding` attribute that nothing reads; §10 of the design accepts that
  // rather than backfilling, because production has not launched.
```

- [ ] **Step 3: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass. `tsc` is the gate that matters here — it is what proves no reference survived.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(dedup): remove the embedding machinery (R43)"
```

---

### Task 9: Rewrite the calibration harness

**Files:**
- Modify: `lib/calibration/record.ts`, `lib/calibration/record.test.ts`
- Modify: `lib/calibration/sweep.ts`, `lib/calibration/sweep.test.ts`
- Modify: `lib/calibration/formats.ts`, `lib/calibration/formats.test.ts`

**Interfaces:**
- Consumes: `matchScore` (Task 2), `buildMatchKey` (Task 1).
- Produces: `CalibrationRecordSchema` carrying `mergeThreshold`, `distinctThreshold`, `weights`, `autoMergePrecision`, `autoSplitRecall`, `bandFraction`, `adjudicatorAccuracy`, `labelledSetHash`, `pairs`, `recordedAt`; `sweepBands(pairs, grid)` returning one row per `(distinct, merge)` combination.

- [ ] **Step 1: Write the failing test**

```ts
// lib/calibration/record.test.ts — add
test("a record without both thresholds does not satisfy the production gate (R48)", () => {
  expect(productionBlocker(null)).not.toBeNull();
  expect(() =>
    CalibrationRecordSchema.parse({ threshold: 0.85, precision: 1, recall: 0.9, pairs: 120 }),
  ).toThrow();
});

test("a complete record clears the gate", () => {
  const record = CalibrationRecordSchema.parse({
    mergeThreshold: 0.72,
    distinctThreshold: 0.35,
    weights: { entities: 0.6, titleTokens: 0.25, tags: 0.15 },
    autoMergePrecision: 1,
    autoSplitRecall: 0.86,
    bandFraction: 0.14,
    adjudicatorAccuracy: 0.93,
    labelledSetHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    pairs: 120,
    recordedAt: "2026-09-01T00:00:00Z",
  });

  expect(productionBlocker(record)).toBeNull();
});
```

`labelledPairs()` returns the harness's fixture pairs. `lib/calibration/sweep.test.ts`
already builds labelled records for the current sweep — reuse that builder,
renaming if needed, and add a `same: boolean` label to each pair if it is not
already there. The sweep needs only `{ fields: MatchKeyFields, other: MatchKeyFields, same: boolean }`.

```ts
// lib/calibration/sweep.test.ts — add
test("sweeps both thresholds and never proposes distinct above merge (R48)", () => {
  const rows = sweepBands(labelledPairs(), { step: 0.05 });

  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.distinctThreshold).toBeLessThanOrEqual(row.mergeThreshold);
  }
});

test("reports band fraction, which is the model-call cost (R48)", () => {
  const [row] = sweepBands(labelledPairs(), { step: 0.5 });

  expect(row?.bandFraction).toBeGreaterThanOrEqual(0);
  expect(row?.bandFraction).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/calibration/`
Expected: FAIL — the schema still requires `threshold`/`model`/`dims`/`inputType`; `sweepBands` is not exported.

- [ ] **Step 3: Implement**

Rewrite `CalibrationRecordSchema` with the fields above; drop `model`, `dims`, `inputType` (R43 — there is no embedding model to name) and `threshold` (R46 — there are two). Keep `MIN_LABELLED_PAIRS = 100` and keep `productionBlocker` refusing on a missing or incomplete record.

Rewrite the sweep as a 2-D grid over `(distinct, merge)` with `distinct <= merge`, scoring each labelled pair once with `matchScore` and bucketing into auto-merge / band / auto-split. Each row reports `autoMergePrecision`, `autoSplitRecall` and `bandFraction`. No model calls: scores come from the analyzed fields, so this runs offline and belongs in the test suite's reach.

Record in a comment that §11.3's steps 2-4 are replaced (R48), that weights come from a coarse grid rather than a continuous sweep because ~100 pairs cannot support five continuous parameters, and that `labelledSetHash` exists because a threshold is a property of the exact set it was tuned on.

- [ ] **Step 4: Run the four gates, and prove the production gate still bites**

```bash
npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth > /dev/null
npx cdk synth -c env=prod -c scheduleEnabled=true 2>&1 | tail -5
```
Expected: gates pass; the prod synth **refuses**, naming the missing recalibration. If it succeeds, the gate has been weakened — stop and fix it.

- [ ] **Step 5: Commit**

```bash
git add lib/calibration/
git commit -m "feat(calibration): sweep two thresholds offline, and record what prod needs (R48)"
```

---

### Task 10: Reconcile the acceptance criteria

**Files:**
- Modify: `test/acceptance.test.ts`
- Modify: `CLAUDE.md` (the dedup boundary note, if it names embeddings)

**Interfaces:**
- Consumes: every test written in Tasks 1–9.
- Produces: a passing bidirectional AC audit.

- [ ] **Step 1: Run the audit to see what it reports**

Run: `npx vitest run test/acceptance.test.ts`
Expected: it names every AC-x.y in §3.1-3.4 with no test, and every test naming an AC that does not exist.

- [ ] **Step 2: Reconcile the wording, keeping the ids**

`docs/telegator-design.md` is authoritative and is **not** edited. AC-3.1, AC-3.3 and AC-3.6 keep their ids; the tests that carry them get a comment recording R47 and the restatement:

- AC-3.1 — "cosine similarity 0.90" becomes "a score at or above `MERGE_THRESHOLD`".
- AC-3.3 — "0.80" becomes "a score at or below `DISTINCT_THRESHOLD`".
- AC-3.6 — "element-wise mean" becomes "the sorted union of the two match keys".
- AC-3.2, AC-3.4, AC-3.5, AC-3.8, AC-3.9 are unchanged.
- AC-3.7 is unchanged in wording, and now holds by the R51 short-circuit rather than by emergent idempotency — record that in its test's comment.

- [ ] **Step 3: Confirm the new criteria are named by tests**

Each of these must be asserted by a test named for it, from Tasks 3 and 5:

- a band pair is adjudicated and the verdict decides;
- a failing adjudication splits and counts `DedupAdjudicationFailed`;
- a verdict set that does not cover the requested ids exactly is an error;
- `J(EMPTY, EMPTY)` scores 0, and two entity-less items do not merge.

- [ ] **Step 4: Run the four gates**

```bash
npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth > /dev/null
```
Expected: all pass, including the bidirectional audit.

- [ ] **Step 5: Commit**

```bash
git add test/acceptance.test.ts CLAUDE.md
git commit -m "test(acceptance): reconcile the dedup criteria to the score and band (R47)"
```

---

## Verification

The pipeline cannot be exercised end-to-end until Bedrock model access is granted for **Claude Haiku 4.5** — `GetUseCaseForModelAccess` currently returns `ResourceNotFoundException`, and every model call fails regardless of this work. Everything in this plan is verifiable offline without it; nothing in it is *confirmed* until a real batch runs.

After access lands:

```bash
npx cdk deploy TelegatorPipelineStack -c reserveConcurrency=false
```

Then push one item through and confirm: the analyze log shows a classification rather than a 403 or 404; the aggregate log shows `DedupAdjudicated` at or near zero on a first batch (nothing to compare against); a second, near-identical item merges rather than creating a second message.
