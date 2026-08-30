import type { AdjudicationFields, AdjudicationPair, Adjudicator } from "../ai/ports";
import type { Clock } from "../clock";
import type { MemberMerge } from "../db/ports";
import { sourceIdOf } from "../domain/ids";
import type { AnalyzedItem } from "../domain/item";
import {
  DEFAULT_TG_CHANNEL,
  type DedupCandidate,
  type MemberBlock,
  type Message,
  type MessageMergeAttributes,
} from "../domain/message";
import { mergeTags } from "../domain/tags";
import type { Logger } from "../logging/logger";
import type { MetricSink } from "../metrics/ports";
import { MAX_MEMBERS } from "./constants";
import {
  buildMatchKey,
  type MatchKey,
  matchKeyAttributes,
  matchKeyOf,
  unionMatchKeys,
} from "./matchKey";
import { type Band, classify, matchScore } from "./score";

/**
 * The normative deduplication algorithm of §6 (L488–553).
 *
 * Pure: it performs no table write and enqueues nothing. §6 L547–552 leave both
 * to the caller, and keeping them out is what makes the whole of §6 testable
 * with no AWS at all.
 *
 * Eight recorded reconciliations are implemented here rather than transcribed:
 *
 *  - **R7** — §6 builds records as `{...item, …}`, which would write `body`,
 *    `kind`, `importance`, `properNames` and `forwardedFrom`, none of them in
 *    §2.3's field table. The descriptive fields are picked explicitly.
 *  - **R8** — §6 assigns `ts` on neither branch, yet §2.3 L152 makes it the sort
 *    key on both GSIs. Every write carries it.
 *  - **R9** — §6 L515 takes candidates from `date-index`, which §7.2 L598 says
 *    projects no `members`. A merge is emitted as an attribute-level operation
 *    and the matched record's members are loaded from the base table first.
 *  - **R10** — §6 L515 re-queries per item, so an item that scores below
 *    threshold against the batch's fresher copy of a message can still match the
 *    stale stored copy and overwrite the batch's own work. Pass 2 skips any
 *    candidate already touched in this batch.
 *  - **R11** — §6 L522 stamps `ts: now()` unconditionally, which makes AC-3.7's
 *    byte-identical replay impossible. An existing member keeps its original
 *    `ts`.
 *  - **R45** — §6 L533 merges two messages by taking the elementwise mean of
 *    their embeddings. With no vector there is nothing to average, so a merged
 *    message's match key is `unionMatchKeys` of the two: it keeps every
 *    discriminating term either side contributed, and — unlike a mean — it is
 *    commutative and idempotent, which is what lets a replayed merge write the
 *    same bytes as the original.
 *  - **R46** — §6 L495–497 embeds the batch and L508/L518 compare cosines
 *    against a single threshold. Both are replaced: the key is built in-process
 *    (no provider call at all on the common path), the comparison is
 *    `matchScore`, and one threshold becomes a band. Above `merge` and below
 *    `distinct` are decided here from the `date-index` projection alone — no
 *    model call, no base-table read; the strip between them is the only thing a
 *    model ever sees, in **one** call for the whole batch, and the only thing
 *    that costs a read to describe to it.
 *  - **R51** — §6 has no replay path: a replayed item is re-scored, and §3.3
 *    L285's "the newest item's descriptive fields overwrite" means the message
 *    it belongs to may no longer resemble it. `memberIds` (§7.2's projection)
 *    settles it by identity instead, before anything is scored.
 */

export interface DedupDeps {
  /**
   * R46 — resolves the ambiguous band. Called at most once per batch, and not
   * at all when nothing falls in the band.
   */
  readonly adjudicator: Adjudicator;
  /** §6 L515 — the `date-index` query. */
  loadCandidatesByDate(date: string): Promise<DedupCandidate[]>;
  /**
   * R9 — the base-table read that supplies what a `date-index` candidate lacks:
   * the `members` a merge needs, and (R46) the `title`, `category` and
   * `location` a band pair describes the candidate with. Memoised per batch.
   */
  loadMessage(id: string): Promise<Message | undefined>;
  readonly clock: Clock;
  readonly metrics: MetricSink;
  /**
   * R46 — an adjudication failure is swallowed here, because splitting is the
   * safe outcome and failing the batch would strand every unambiguous item in
   * it. The metric records that it happened; this records *why*.
   */
  readonly logger: Logger;
  /**
   * §11.3 L864 requires the decision boundary to be recalibrated before
   * production — against Cohere as written, against the labelled set as R48
   * rewrites it. Injected, exactly as `similarityThreshold` was, so that
   * recalibration stays a configuration change rather than a code edit (R46).
   */
  readonly band?: Band;
}

export type DedupWrite =
  | { readonly kind: "create"; readonly message: Message }
  | { readonly kind: "merge"; readonly merge: MemberMerge };

export interface DedupResult {
  readonly writes: readonly DedupWrite[];
  /** §6 L548 — every touched message id. */
  readonly toPublish: readonly string[];
  /** §7.2 L600 — alarmed above 500, where §6's in-memory assumption stops holding. */
  readonly candidateCount: number;
}

/** The effective state of a message touched by this batch. */
interface Pending {
  readonly id: string;
  readonly date: string;
  readonly isNew: boolean;
  /** R45 — the union of every member's key; what Pass 1 scores against. */
  key: MatchKey;
  members: Record<string, MemberBlock>;
  /** The members *this batch* wrote — the ones a merge must SET. */
  addedMembers: Record<string, MemberBlock>;
  /**
   * What the stored record rendered as before this batch touched it (R39).
   *
   * `undefined` for a message this batch created. §2.3 L168 argues that
   * "re-processing a replayed item writes `members.{itemId}` with the same value
   * — a no-op", but §6 L527's merge branch also writes `status: "topublish"`,
   * which returns an already-published message to the publish queue and edits
   * the live post with its own text. Comparing the finished state against this
   * snapshot is what tells the two apart.
   *
   * A snapshot rather than a running flag, because §3.3 L285 has each item's
   * descriptive fields overwrite: replaying two members writes the first item's
   * title and then the second's, so an incremental check sees a change in a
   * state that ends up identical.
   */
  readonly origin: PublishedContent | undefined;
  tags: string;
  image: string | undefined;
  title: string | undefined;
  category: string | undefined;
  country: string | undefined;
  location: string | undefined;
  peoples: string | undefined;
  tgChannel: string;
}

/** An item whose best candidate fell in the band, held until the verdicts arrive. */
interface Deferred {
  readonly pairId: string;
  readonly item: AnalyzedItem;
  readonly key: MatchKey;
  readonly candidate: Best;
}

/** The best-scoring candidate found for one item, across both passes. */
interface Best {
  readonly id: string;
  readonly score: number;
  /** Kept for the fallback in `bandFieldsOf`, when the base record cannot be read. */
  readonly key: MatchKey;
  readonly date: string;
}

/**
 * Everything `fieldsOf` needs, from a `Pending` or a stored `Message` alike.
 *
 * `title`, `category` and `location` are `string | undefined` rather than
 * optional properties so both shapes satisfy it: a `Message` declares them
 * optional and a `Pending` declares them nullable, and reading either yields
 * exactly this.
 */
interface Described {
  readonly key: MatchKey;
  readonly date: string;
  readonly title: string | undefined;
  readonly category: string | undefined;
  readonly location: string | undefined;
}

export async function dedupBatch(
  batch: readonly AnalyzedItem[],
  deps: DedupDeps,
): Promise<DedupResult> {
  if (batch.length === 0) {
    return { writes: [], toPublish: [], candidateCount: 0 };
  }

  // R46 — §6 L495–497's single `embedBatch` call, replaced by a pure build.
  // Nothing here awaits a model: a batch with no ambiguous pair never calls one.
  const keyed = batch.map((item) => ({ item, key: buildMatchKey(item) }));

  const pending = new Map<string, Pending>();
  const toPublish: string[] = [];
  // All items in a batch share one date (§7.3 L607's FIFO group), and nothing is
  // written until the caller applies the result — so §6 L515's per-item query
  // returns the same rows every time. Caching it is what §6 L557's own cost
  // model ("10 items x 200 candidates is 2,000 comparisons") already assumes.
  const candidatesByDate = new Map<string, DedupCandidate[]>();
  let candidateCount = 0;

  const candidatesFor = async (date: string): Promise<DedupCandidate[]> => {
    const cached = candidatesByDate.get(date);
    if (cached !== undefined) return cached;

    const candidates = await deps.loadCandidatesByDate(date);
    candidatesByDate.set(date, candidates);
    candidateCount += candidates.length;
    return candidates;
  };

  /**
   * R9's base-table read, memoised.
   *
   * Two callers now want the whole record rather than the `date-index`
   * projection: the merge branch below, which has always needed `members`, and
   * `bandFieldsOf`, which needs the descriptive fields §7.2 L598 does not
   * project. Memoising keeps that at one `GetItem` per candidate per batch
   * rather than one per caller. `absorb` never mutates the state it is given —
   * it builds `next` by spreading — so handing the same one to both is safe.
   */
  const loadedById = new Map<string, Pending | undefined>();
  const loadPending = async (id: string): Promise<Pending | undefined> => {
    if (loadedById.has(id)) return loadedById.get(id);

    const state = await load(id, deps);
    loadedById.set(id, state);
    return state;
  };

  /**
   * §6 L521–544 — the create/merge tail, shared by the items decided on sight
   * and the ones decided by the model. Factored out for exactly that reason: a
   * second copy is how the two paths would drift on R11 or the member cap.
   */
  const absorb = async (item: AnalyzedItem, key: MatchKey, matchId: string | undefined) => {
    const state =
      matchId === undefined ? undefined : (pending.get(matchId) ?? (await loadPending(matchId)));

    if (matchId !== undefined && state === undefined) {
      throw new Error(`matched message ${matchId} disappeared between query and read`);
    }

    if (state !== undefined) {
      // §6 L525–526 — the cap rejects only a *new* key, so a replay of an item
      // already present still merges. Returning drops the item outright: no
      // message is created for it and nothing is enqueued.
      if (Object.keys(state.members).length >= MAX_MEMBERS && !(item.id in state.members)) {
        deps.metrics.count("MemberCapReached", 1);
        return;
      }
    }

    // §6 L521–522, with R11's preservation.
    const existing = state?.members[item.id];
    const block: MemberBlock = {
      summary: item.summary,
      links: item.links,
      channel: sourceIdOf(item.id),
      ts: existing?.ts ?? deps.clock.now(),
    };

    const next: Pending =
      state === undefined
        ? {
            id: item.id,
            date: item.date,
            isNew: true,
            key,
            members: { [item.id]: block },
            addedMembers: { [item.id]: block },
            origin: undefined,
            tags: mergeTags(item.tags),
            image: item.image,
            title: item.title,
            category: item.category,
            country: item.country,
            location: item.location,
            peoples: item.peoples,
            tgChannel: item.tgChannel ?? DEFAULT_TG_CHANNEL,
          }
        : {
            ...state,
            // R45 — the union, where §6 L533 took the elementwise mean.
            key: unionMatchKeys(state.key, key),
            members: { ...state.members, [item.id]: block },
            addedMembers: { ...state.addedMembers, [item.id]: block },
            // §6 L532 — item side first, so a replay is a fixed point.
            tags: mergeTags(item.tags, state.tags),
            // §6 L530 uses `??`, which keeps an empty-string image (R30).
            image: state.image ?? item.image,
            // §3.3 L285 — the newest item's descriptive fields overwrite.
            title: item.title,
            category: item.category,
            country: item.country,
            location: item.location,
            peoples: item.peoples,
            tgChannel: item.tgChannel ?? DEFAULT_TG_CHANNEL,
          };

    deps.metrics.count(state === undefined ? "MessagesCreated" : "MessagesMerged", 1);

    pending.set(next.id, next);
    if (!toPublish.includes(next.id)) toPublish.push(next.id);
  };

  const deferred: Deferred[] = [];

  for (const { item, key } of keyed) {
    /**
     * R51, AC-3.7 — the replay short-circuit, ahead of every comparison.
     *
     * An item already listed in a same-date message's `memberIds` belongs to
     * that message by identity, whatever it would now score: §3.3 L285 lets
     * later members overwrite the descriptive fields, so a replayed item can
     * have drifted well away from the key it helped build. Re-scoring it is how
     * a DLQ drain splits a story that was already published and posts it twice.
     *
     * R10's "skip a candidate this batch already touched" deliberately does not
     * apply here: when the candidate is in `pending`, `absorb` resolves against
     * that fresher copy, which is the right answer rather than a stale one.
     */
    const replayed =
      item.date === ""
        ? undefined
        : (await candidatesFor(item.date)).find((candidate) =>
            candidate.memberIds.includes(item.id),
          );

    if (replayed !== undefined) {
      await absorb(item, key, replayed.id);
      continue;
    }

    let best: Best | undefined;
    const better = (candidate: Best) => {
      // §6 L510 records any improvement, with no threshold test.
      if (best === undefined || candidate.score > best.score) best = candidate;
    };

    // Pass 1 — messages touched earlier in this batch (§6 L505–511).
    for (const candidate of pending.values()) {
      if (candidate.date !== item.date) continue;
      better({
        id: candidate.id,
        score: matchScore(key, candidate.key),
        key: candidate.key,
        date: candidate.date,
      });
    }

    /**
     * Pass 2 — stored messages on the same date (§6 L513–519).
     *
     * §6 L513 runs this only when Pass 1 found no match; both passes run here
     * and the single highest score across them wins (R46). §6's structure
     * relies on one threshold making "matched" a yes/no answer, which a band
     * does not: an item's best candidate has to be settled before it can be
     * classified at all, and stopping at Pass 1 would send one pair to the
     * model while a closer one went unexamined. Taking the maximum can only
     * select a candidate at least as close as §6's would have been.
     */
    if (item.date !== "") {
      for (const candidate of await candidatesFor(item.date)) {
        // R10 — the batch already holds a fresher copy of this message.
        if (pending.has(candidate.id)) continue;
        const stored = matchKeyOf(candidate);
        better({
          id: candidate.id,
          score: matchScore(key, stored),
          key: stored,
          date: candidate.date,
        });
      }
    }

    if (best === undefined) {
      await absorb(item, key, undefined);
      continue;
    }

    const verdict = classify(best.score, deps.band);
    if (verdict === "adjudicate") {
      // At most one pair per item: only the highest-scoring candidate is ever
      // the one this item might belong to. The pair itself is built after the
      // loop, because describing the candidate needs a read.
      deferred.push({ pairId: `${item.id}->${best.id}`, item, key, candidate: best });
      continue;
    }

    await absorb(item, key, verdict === "merge" ? best.id : undefined);
  }

  const pairs: AdjudicationPair[] = [];
  for (const entry of deferred) {
    pairs.push({
      id: entry.pairId,
      item: fieldsOf({
        key: entry.key,
        date: entry.item.date,
        title: entry.item.title,
        category: entry.item.category,
        location: entry.item.location,
      }),
      candidate: await bandFieldsOf(entry.candidate, pending, loadPending),
    });
  }

  const verdicts = await adjudicate(pairs, deps);

  for (const entry of deferred) {
    // `=== true` rather than a truthiness test: a verdict map that answers some
    // pairs and not others must split the ones it did not answer, exactly as a
    // failed call does.
    await absorb(
      entry.item,
      entry.key,
      verdicts.get(entry.pairId) === true ? entry.candidate.id : undefined,
    );
  }

  deps.metrics.count("DedupCandidateCount", candidateCount);

  const now = deps.clock.now();
  const writes = [...pending.values()].map((state) => toWrite(state, now));

  // R39 — a merge that changed nothing a reader would see must not be published
  // again. Filtered here rather than per item because §3.3 L285's overwrite
  // makes an intermediate state differ from one that ends up identical.
  const republished = new Set(
    [...pending.values()]
      .filter((state) => changedPublishedContent(state))
      .map((state) => state.id),
  );

  return {
    writes,
    toPublish: toPublish.filter((id) => republished.has(id)),
    candidateCount,
  };
}

/**
 * R46 — one call for the batch, and a failure that splits.
 *
 * §11.3 L868: "False merges are worse than false splits." A false merge fuses
 * two unrelated stories into one live Telegram post that then keeps editing
 * itself with the other story's text; a false split is a second post. So a
 * throw, a timeout or a refusal returns no verdicts at all and every pending
 * pair falls through to `distinct` — never to `merge`, and never to a thrown
 * batch, which would strand the items that were never ambiguous.
 */
async function adjudicate(
  pairs: readonly AdjudicationPair[],
  deps: DedupDeps,
): Promise<ReadonlyMap<string, boolean>> {
  if (pairs.length === 0) return new Map();

  try {
    const verdicts = await deps.adjudicator.adjudicate(pairs);
    deps.metrics.count("DedupAdjudicated", pairs.length);
    return verdicts;
  } catch (error) {
    deps.logger.error("dedup adjudication failed; splitting every ambiguous pair", {
      pairs: pairs.length,
      error: error instanceof Error ? error.message : String(error),
    });
    deps.metrics.count("DedupAdjudicationFailed", 1);
    return new Map();
  }
}

/**
 * R46 — what crosses the model boundary.
 *
 * `entities` and `tags` are the match key's, because that is the canonical form
 * of §5.2 L451-453's comma-separated fields and both sides have one. `title`,
 * `category` and `location` are the record's own, as written.
 *
 * The key-derived title is a fallback for a record that has none — a pre-R44
 * row, or one whose base read failed. It is a poor substitute: `titleTokens` is
 * lowercased and alphabetised, so it carries no word order.
 *
 * `summary` and `body` are absent, and stay absent. §5.2 has already reduced
 * the discriminating signal to English; sending Belarusian or Russian source
 * text back to a model would make the call large, slow and language-dependent
 * for no gain.
 */
function fieldsOf(from: Described): AdjudicationFields {
  return {
    title: from.title ?? from.key.titleTokens.join(" "),
    entities: from.key.entities,
    tags: from.key.tags,
    category: from.category,
    location: from.location,
    date: from.date,
  };
}

/**
 * R46 — the candidate's side of a band pair, from the base table.
 *
 * §7.2 L598's `date-index` projection is the match key and `memberIds` (R44,
 * R51) and nothing else, so a scored candidate has no `title`, `category` or
 * `location`. Describing it from its key would hand the model exactly the three
 * token sets `matchScore` has just used and failed to decide on — a tie broken
 * with the data that produced the tie — and would leave the two sides of the
 * pair differently shaped depending on which one happened to be stored, which
 * is the artefact this whole boundary exists to avoid.
 *
 * One read per band pair, so at most one per item and ten per batch (§7.3
 * L607's cap), and only here: `merge` and `distinct` are decided from the
 * projection alone, with no model call and no base-table read. `loadPending` is
 * memoised, so a candidate the merge branch also reads is read once.
 *
 * A record that cannot be read — missing, or a read that throws — falls back to
 * the key-derived form rather than propagating. A degraded verdict beats a
 * failed batch, and this path already splits when the model itself is
 * unavailable. The failure is not swallowed for the *merge* branch: if the
 * verdict comes back `same`, `absorb` reads the record again through the same
 * memo and a genuine table failure still fails the batch there, where §7.3
 * L620 wants it to.
 */
async function bandFieldsOf(
  candidate: Best,
  pending: ReadonlyMap<string, Pending>,
  loadPending: (id: string) => Promise<Pending | undefined>,
): Promise<AdjudicationFields> {
  // A message this batch already touched is fresher than the table, and needs
  // no read at all.
  const described =
    pending.get(candidate.id) ?? (await loadPending(candidate.id).catch(() => undefined));

  if (described === undefined) {
    return fieldsOf({
      key: candidate.key,
      date: candidate.date,
      title: undefined,
      category: undefined,
      location: undefined,
    });
  }

  return fieldsOf({
    key: described.key,
    date: described.date,
    title: described.title,
    category: described.category,
    location: described.location,
  });
}

/** R9 — a `date-index` candidate carries no members, so read the base record. */
async function load(id: string, deps: DedupDeps): Promise<Pending | undefined> {
  const message = await deps.loadMessage(id);
  if (message === undefined) return undefined;

  return {
    id: message.id,
    date: message.date,
    isNew: false,
    origin: publishedContentOf(message),
    key: matchKeyOf(message),
    members: message.members,
    addedMembers: {},
    tags: message.tags ?? "",
    image: message.image,
    title: message.title,
    category: message.category,
    country: message.country,
    location: message.location,
    peoples: message.peoples,
    tgChannel: message.tgChannel,
  };
}

/**
 * The fields §3.4 actually renders: the member blocks carry the text, the rest
 * carry the header and the hashtag line.
 *
 * The match key is deliberately absent, for the reason `embedding` was before
 * it (R43/R45): it changes on every merge, no reader ever sees it, and
 * including it would make every merge look like a change and the comparison
 * pointless.
 */
interface PublishedContent {
  readonly members: string;
  readonly title: string | undefined;
  readonly category: string | undefined;
  readonly country: string | undefined;
  readonly location: string | undefined;
  readonly peoples: string | undefined;
  readonly tags: string;
  readonly image: string | undefined;
}

const publishedContentOf = (message: {
  members: Record<string, MemberBlock>;
  title?: string;
  category?: string;
  country?: string;
  location?: string;
  peoples?: string;
  tags?: string;
  image?: string;
}): PublishedContent => ({
  members: JSON.stringify(message.members),
  title: message.title,
  category: message.category,
  country: message.country,
  location: message.location,
  peoples: message.peoples,
  tags: message.tags ?? "",
  image: message.image,
});

/** Whether the finished state renders differently from what was stored. */
function changedPublishedContent(state: Pending): boolean {
  if (state.origin === undefined) return true;

  const now = publishedContentOf(state);
  return (Object.keys(now) as (keyof PublishedContent)[]).some(
    (key) => now[key] !== state.origin?.[key],
  );
}

function toWrite(state: Pending, ts: number): DedupWrite {
  const memberCount = Object.keys(state.members).length;

  const shared = {
    memberCount,
    /**
     * R45 — the three projections §7.2 L598 scores on, written from the union
     * `absorb` maintained. `embedding` is not written at all: nothing computes
     * one any more, and R43 removed it from the schema — a stored record's
     * orphan bytes are simply never touched again, rather than overwritten
     * with a stale value.
     */
    ...matchKeyAttributes(state.key),
    /**
     * R51 — unlike the match key, this needs no algorithm: `state.members` is
     * already the message's complete, up-to-date member map on both the create
     * and the merge branch below, so its keys are `memberIds` by construction.
     * Kept in lockstep with `members` for exactly that reason, which is what
     * makes the replay short-circuit above correct rather than merely fast.
     */
    memberIds: Object.keys(state.members),
    date: state.date,
    title: state.title,
    category: state.category,
    country: state.country,
    location: state.location,
    peoples: state.peoples,
    tags: state.tags,
    image: state.image,
    tgChannel: state.tgChannel,
    ts,
    // R39 — omitted when the merge is publication-neutral, so a replayed
    // message stays `published` instead of being edited with its own text.
    ...(changedPublishedContent(state) ? { status: "topublish" } : {}),
  } satisfies MessageMergeAttributes;

  if (state.isNew) {
    // A create always publishes: there is no stored record for it to render
    // identically to. Stated rather than inherited from `shared`, whose `status`
    // is conditional for the merge branch below (R39).
    return {
      kind: "create",
      message: { id: state.id, members: state.members, ...shared, status: "topublish" },
    };
  }

  // Attribute-level, so `tgId` and `tgAt` — which publish owns — are untouched.
  // Every member this batch added is SET, not just the last: one batch can
  // absorb several items into the same message.
  return {
    kind: "merge",
    merge: { id: state.id, members: state.addedMembers, attributes: shared },
  };
}
