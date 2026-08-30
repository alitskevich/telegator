# Deduplication without embeddings

**Date:** 2026-08-30
**Status:** approved design, not yet planned or implemented
**Supersedes in practice:** §5.3, and parts of §3.3, §6, §7.2, §7.6, §7.7 and §11.3
of `docs/telegator-design.md` — enumerated as reconciliations R43–R51 below.

## 1. Why

`aggregate` deduplicates by embedding each item with
`cohere.embed-multilingual-v3` and comparing cosine similarity against
same-date candidates. The operator has ruled out Cohere.

Investigation while diagnosing an unrelated failure established three facts that
shape this design:

1. **No Bedrock model is reachable in this account.** `GetUseCaseForModelAccess`
   returns `ResourceNotFoundException` ("You have not filled out the request
   form"), and every `bedrock-runtime` call — Cohere, Titan and Anthropic alike —
   fails `ValidationException: Operation not allowed`. Dropping Cohere does not
   avoid the model-access form.
2. **`analyze` needs Claude regardless**, so the form is unavoidable. The
   achievable win is going from two model dependencies to one, not to zero.
3. **The cross-lingual problem is already solved one stage earlier.**
   `NewsItemSchema` makes the classifier emit `title`, `peoples`, `properNames`,
   `location` and `tags` in English, plus `category` (enum) and `country`
   (ISO-3166). Only `summary` (Belarusian) and `body` (Russian/Ukrainian) are
   not language-neutral — and `buildEmbeddingText` concatenates exactly those two
   into the vector. §5.3's whole Cohere-over-Titan argument exists to serve two
   fields a dedup key does not need.

Matching on the English structured fields is therefore language-neutral without
any embedding at all.

## 2. Decision

Replace vector similarity with a **hybrid**: a deterministic entity-anchored
score decides clear cases, and Claude adjudicates an ambiguous band.

Rejected alternatives:

- **Titan v2 instead of Cohere.** Blocked by the same access gate, rejected by
  §5.3 L463 as English-centric, and its API embeds one `inputText` per call —
  turning one batch call into ten.
- **Purely deterministic.** Cheapest and fully offline, but a paraphrase with
  disjoint proper names splits, with no recourse.
- **Claude judges every pair.** Removes the deterministic half's cost advantage
  and makes §6 non-deterministic throughout.
- **A `storyKey` emitted at analyze time.** Requires two independent
  classifications of two different source texts to converge on one slug without
  either seeing the other — the weakest kind of cross-call consistency.

## 3. Non-goals

- Changing the `date` gate, the FIFO grouping, or the 20-member cap.
- Changing stages 1, 2 or 4.
- Backfilling existing `messages` rows (see §10).
- Removing the production calibration gate. It is strengthened, not relaxed.

## 4. Architecture

### Removed

| Module | Reason |
| --- | --- |
| `lib/ai/ports.ts` → `EmbeddingProvider` | no embeddings |
| `lib/ai/bedrock.ts` → `createBedrockEmbeddingProvider`, `BedrockInvoker`, `parseEmbeddings` | no embeddings |
| `lib/ai/constants.ts` → `EMBEDDING_MODEL_ID`, `EMBEDDING_INPUT_TYPE`, `EMBEDDING_MAX_BATCH` | no embeddings |
| `lib/dedup/constants.ts` → `DIMENSIONS`, `EMBEDDING_BYTE_LENGTH`, `SIMILARITY_THRESHOLD` | replaced by band constants |
| `lib/dedup/cosine.ts`, `lib/dedup/vectors.ts`, `lib/dedup/embeddingText.ts` | replaced |
| `lib/db/embeddingCodec.ts` | no stored vectors |
| `infra/lib/pipeline-stack.ts` → `invokeModel()` | no `bedrock-runtime` caller remains |

### Added

| Module | Purpose |
| --- | --- |
| `lib/dedup/matchKey.ts` | build and canonicalise `{entities, titleTokens, tags}` |
| `lib/dedup/score.ts` | weighted Jaccard, band classification |
| `lib/dedup/constants.ts` → `MERGE_THRESHOLD`, `DISTINCT_THRESHOLD`, `SCORE_WEIGHTS`, `MATCH_KEY_CAP` | tunables, injected |
| `memberIds` attribute + `date-index` projection | free replay detection (§5) |
| `lib/ai/adjudicator.ts` | `Adjudicator` port, Mantle adapter, verdict schema |
| `test/fakes/adjudicator.ts` | in-memory fake |

`DedupDeps.embeddings` becomes `DedupDeps.adjudicator` — one injected port with
an in-memory fake, exactly as before, so §6 stays offline-testable and no test
touches the network.

### Flow

```
1. item-id short-circuit ....... any same-date candidate whose memberIds
                                 contain this item id? merge there,
                                 no scoring, no model call
2. build match keys ............ pure, in-process
3. pass 1: local (this batch) .. score; R10 still applies
4. pass 2: stored candidates ... score
5. best candidate per item -> band? collect
   ONE adjudication call for the whole batch (<= 10 pairs)
6. merge / create
```

Step 5 batches per invocation, not per pair: worst case one model call per
batch. Only the single highest-scoring candidate per item is ever adjudicated.

## 5. Data model

`embedding` (Binary, 4 KB) is replaced by three String List attributes on
`telegator-messages`: `keyEntities`, `keyTitle`, `keyTags`.

A fourth attribute, `memberIds` (String List, <=20 short ids), carries the ids
already in `members`. It exists for the §4 step-1 short-circuit: an item that
*created* a message is addressable as `loadMessage(item.id)`, because §3.3 sets
`id` = item id on the create branch — but an item that *merged* has its id only
inside another message's `members` map, and R9 records that `date-index` projects
no `members`. Without `memberIds` the short-circuit would need a base-table read
per candidate. Projected on `date-index`, it makes replay detection free: the
candidate query is one this stage already runs.

Lists, not DynamoDB String Sets: a set cannot be empty and an item with no tags
is legal. Lists also read cleanly in the console.

**Canonical form.** Every set is lowercased, trimmed, punctuation-stripped,
deduplicated and **sorted** at write time. `peoples` and `properNames` split on
commas (the schema guarantees comma-separated English); `title` splits on
whitespace. Identical input serialises to identical bytes — this is what makes
AC-3.7 hold.

**Merge.** Sorted union, capped at `MATCH_KEY_CAP = 256` entries per set in
lexical order.

The cap is a **storage bound, not a signal filter**, and the number is chosen so
it is not normally reached: 20 members contributing ~10 terms each is ~200. An
earlier draft capped at 64 "by frequency then lexical order", which is not
implementable as stated — frequency across members is not recoverable from a
union list, and nothing stores per-term counts. Frequency-weighted capping would
need a count attribute; it is deferred until the cap is observed to bind.

**GSI.** `date-index` projects the three key attributes plus `memberIds`,
instead of `embedding`. `status-index` continues to exclude them.

The candidate query drops from ~4 KB per candidate to a few hundred bytes. The
`DedupCandidateCount > 500` alarm stays at 500 until measured; moving it on
reasoning alone is the kind of guess §11.3 exists to prevent.

## 6. The rule

```
score = w_e * J(entities) + w_t * J(titleTokens) + w_g * J(tags)
J(x, y) = |x n y| / |x u y|
```

Provisional weights `w_e = 0.60`, `w_t = 0.25`, `w_g = 0.15`.

**`J(EMPTY, EMPTY) === 0`, never 1.** Two items that both lack entities have no
evidence, not perfect agreement. The naive expression is `0/0`; any reading that
treats it as equality auto-merges every sparse pair.

**Gate:** same `date`, unchanged — still §3.3's correctness rule and still the
FIFO group. Deliberately *not* gated on `category` or `country`: §5.2 permits two
sources' classifications to differ, so gating there forces a false split on a
real duplicate. If category carries signal, calibration can earn it a weight.

**Band:**

```
score >= MERGE_THRESHOLD     -> merge      (no model call)
score <= DISTINCT_THRESHOLD  -> separate   (no model call)
otherwise                    -> adjudicate
```

Both thresholds are injected with defaults, as `similarityThreshold` is today, so
recalibration is a configuration change rather than a code edit. Defaults are
**provisional placeholders** until §9's sweep runs; the production gate refuses
to synth until real values are recorded.

## 7. The adjudicator

```ts
export interface AdjudicationPair {
  readonly id: string;              // stable, caller-assigned
  readonly item: AdjudicationFields;
  readonly candidate: AdjudicationFields;
}

export interface Adjudicator {
  adjudicate(pairs: readonly AdjudicationPair[]): Promise<AdjudicationVerdicts>;
}
```

`AdjudicationFields` carries only the English structured fields — title,
entities, tags, category, location, date. Never `body`, never `summary`: the
call stays small and language-neutral.

**Verdicts are keyed by pair id and validated for exact coverage — never
positional.** `parseEmbeddings` checks its returned count precisely because "§6
indexes `embeddings[idx]` against `batch[idx]`, so a short or misaligned response
would silently attach the wrong vector to every subsequent item — a dedup fault
with no error anywhere". A positional verdict array reintroduces that class with
a model that can return fewer answers than it was asked for. A verdict set that
does not cover the requested ids exactly is an error, not a partial result.

The response is constrained by a Zod-derived strict output schema, the way
`NEWS_ITEM_SCHEMA` constrains the classifier.

`ADJUDICATOR_MODEL_ID` defaults to `CLASSIFIER_MODEL_ID`'s value but is its own
constant, so the two tasks can diverge without reopening R2.

**Failure defaults to split.** §11.3: "False merges are worse than false splits —
a wrong merge publishes two unrelated stories as one." An adjudication that
throws, times out, or refuses yields *distinct*, and increments
`DedupAdjudicationFailed`. A false split is a duplicate post; a false merge fuses
two unrelated stories under one Telegram message that then keeps editing itself.

New counters: `DedupAdjudicated`, `DedupAdjudicationFailed`.

## 8. IAM

`aggregate`'s `bedrock:InvokeModel` grant becomes `createInference()` — the
`bedrock-mantle:CreateInference` statement R42 added for `analyze`. With no
`bedrock-runtime` caller left, `invokeModel()` is deleted and
`bedrock-mantle:CreateInference` becomes the stack's only Bedrock grant, held by
both functions. The account then needs model access for exactly one model.

## 9. Calibration (§11.3, rewritten)

The labelled set survives unchanged — >=100 hand-judged same-story /
different-story pairs, model-agnostic and the real asset. Everything around it
changes:

1. Assemble >=100 hand-judged pairs. **(unchanged)**
2. ~~Embed with Cohere.~~ **Removed.** Scores come from the analyzed fields, so
   the deterministic sweep runs entirely offline with zero model calls.
3. 2-D sweep over `(DISTINCT_THRESHOLD, MERGE_THRESHOLD)`, `DISTINCT <= MERGE`.
4. Objective, three-way:
   - maximise auto-merge precision (false merges are the costly error)
   - maximise auto-split recall
   - minimise band volume, which is the model-call cost
   i.e. the widest auto regions subject to both error floors.
5. Measure adjudicator accuracy on band pairs only. This part does spend model
   calls; the measured value is recorded.
6. Record thresholds, weights, curve, **labelled-set hash**, and adjudicator
   accuracy.

**Weights are not swept continuously.** Five continuous parameters fitted to ~100
pairs overfits and produces a curve that means nothing. Weights come from a
coarse grid of two or three hand-reasoned candidates; only the two thresholds are
swept. The labelled-set hash is recorded for the same reason a threshold is a
property of the exact text that was embedded: it is a property of the exact set
it was tuned on.

**The production gate stays.** `cdk synth -c env=prod -c scheduleEnabled=true`
continues to refuse until `calibration/record.json` exists.
`lib/calibration/record.ts`'s schema grows to carry the fields above. Nothing
about the gate is relaxed.

## 10. Migration

None. Existing dev rows keep a dead `embedding` and have no match key, so they
score 0 and never match — at most a day of duplicates against pre-change
messages, after which they age out of `date-index`. Production has not launched.

## 11. Spec reconciliations

| # | Section | Divergence |
| --- | --- | --- |
| R43 | §5.3 | The embedding model is removed entirely; dedup no longer embeds. |
| R44 | §7.2 L590, L598 | `embedding` Binary replaced by three String Lists plus `memberIds`; `date-index` projects those instead. |
| R45 | §3.3 | Merge rule `embedding <- elementwise mean` becomes `key <- sorted union`, capped at 64. |
| R46 | §6 L495-497 | One embed call per batch becomes pure match-key construction; matching is weighted Jaccard with a two-threshold band. |
| R47 | §3.3 AC-3.1, AC-3.3, AC-3.6 | Restated from cosine terms. Ids are preserved; wording is reconciled in the implementing comments. |
| R48 | §11.3 | Recalibration rewritten: no embedding step, 2-D sweep, three-way objective, adjudicator accuracy. |
| R49 | §7.6 L670 | `aggregate`'s `bedrock:InvokeModel` becomes `bedrock-mantle:CreateInference` (follows R42). |
| R50 | §7.7 | Metric table gains `DedupAdjudicated` and `DedupAdjudicationFailed`. |
| R51 | §3.3 AC-3.7, §7.2 | Byte-identical replay is guaranteed by an explicit item-id short-circuit over a new projected `memberIds` attribute, rather than emerging from idempotent member writes. |

`docs/telegator-design.md` is authoritative and is not edited. Each reconciliation
is recorded in the comment that makes it, with its reason.

## 12. Acceptance criteria

Existing ids are kept and their wording reconciled (R47):

| AC | Restated as |
| --- | --- |
| AC-3.1 | Two same-date items scoring above `MERGE_THRESHOLD` produce one message with two members. |
| AC-3.2 | Unchanged — the `date` gate. |
| AC-3.3 | Two items scoring below `DISTINCT_THRESHOLD` produce two messages. |
| AC-3.6 | A message's match key after merging equals the sorted union of the inputs. |
| AC-3.7 | Strengthened — replay is a lookup via the item-id short-circuit. |

New criteria, added to `test/acceptance.test.ts`'s bidirectional audit:

- A pair scoring inside the band is adjudicated, and the verdict decides.
- A failing adjudication splits, and increments `DedupAdjudicationFailed`.
- A verdict set that does not cover the requested pair ids exactly is an error.
- `J(EMPTY, EMPTY)` scores 0, and two entity-less items do not merge.

## 13. Testing

- Pure unit tests: canonical form (byte-identical serialisation), scoring
  including the empty-set trap, band classification, union cap determinism.
- `dedupBatch` against an in-memory fake adjudicator: merge / split / band /
  failure-splits / short-verdict-set-rejected.
- No test touches the network. All four gates apply: `tsc`, `vitest`, `biome`,
  `cdk synth`.
- Constants needed by two layers move to a module neither owns.

## 14. Open items

- Provisional thresholds and weights are placeholders. The production gate
  enforces that they are replaced before prod.
- Bedrock model access remains ungranted; nothing in this design can be
  end-to-end verified until the form is submitted for Claude Haiku 4.5.
- Adjudicator prompt wording is not specified here. It is an implementation
  concern, constrained by the output schema and the field list in §7.
