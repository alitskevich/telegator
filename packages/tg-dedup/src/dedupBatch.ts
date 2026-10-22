import type { AdjudicationFields, AdjudicationPair } from "tg-ai/types";
import { MAX_MEMBERS } from "tg-configs/dedup";
import { sourceIdOf } from "tg-domain/ids";
import type { AnalyzedItem } from "tg-domain/item";
import type {
  DedupCandidate,
  MemberBlock,
  Message,
  MessageMergeAttributes,
} from "tg-domain/message";
import { mergeTags } from "tg-domain/tags";
import { buildMatchKey, matchKeyAttributes, matchKeyOf, unionMatchKeys } from "./matchKey";
import { classify, matchScore } from "./score";
import type { DedupDeps, DedupResult, MatchKey, MemberMerge } from "./types";

/**
 * The deduplication algorithm (see docs/telegator.md §5). Pure: it writes
 * nothing and enqueues nothing; the caller applies the result.
 *
 *  - Descriptive fields are picked explicitly, so a spread cannot write fields a
 *    message does not have. Every write carries `ts`.
 *  - The date query returns no `members`, so a merge writes field by field and
 *    the matched message is read in full.
 *  - Pass 2 skips a candidate this batch already touched, so a stale stored
 *    copy cannot overwrite fresher work.
 *  - An existing member keeps its original `ts`, so replay is byte-identical.
 *  - A merged key is `unionMatchKeys`: commutative and idempotent.
 *  - Only the ambiguous band costs a model call, and one call serves the batch.
 *  - Replay is settled by `memberIds` before any scoring, because later members
 *    overwrite the fields a replay would match on.
 */

export type DedupWrite =
  | { readonly kind: "create"; readonly message: Message }
  | { readonly kind: "merge"; readonly merge: MemberMerge };

/** The effective state of a message touched by this batch. */
interface Pending {
  readonly id: string;
  readonly date: string;
  readonly isNew: boolean;
  /** The union of every member's key; what Pass 1 scores against. */
  key: MatchKey;
  members: Record<string, MemberBlock>;
  /** The members *this batch* wrote — the ones a merge must SET. */
  addedMembers: Record<string, MemberBlock>;
  /**
   * What the stored message rendered as before this batch, or `undefined` for a
   * new one. A merge sets `topublish`, so a replay that changes nothing would
   * re-edit the live post; comparing against this snapshot prevents that.
   *
   * A snapshot, not a running flag: each item's fields overwrite the last, so a
   * middle state can differ while the final state is identical.
   */
  readonly origin: PublishedContent | undefined;
  tags: string[];
  image: string | undefined;
  title: string | undefined;
  category: string | undefined;
  country: string | undefined;
  location: string | undefined;
  peoples: string | undefined;
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
  /** Kept for the fallback in `bandFieldsOf`, when the full message cannot be read. */
  readonly key: MatchKey;
  readonly date: string;
}

/**
 * Everything `fieldsOf` needs, from a `Pending` or a stored `Message`. Fields
 * are `string | undefined`, not optional, so both shapes satisfy it.
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

  // Built in-process: a batch with no ambiguous pair never calls a model.
  const keyed = batch.map((item) => ({ item, key: buildMatchKey(item) }));

  const pending = new Map<string, Pending>();
  const toPublish: string[] = [];
  // Nothing is written until the caller applies the result, so the per-date
  // query returns the same rows every time and is cached.
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
   * The full-message read, memoised to one read per candidate per batch.
   * `absorb` spreads rather than mutates, so sharing is safe.
   */
  const loadedById = new Map<string, Pending | undefined>();
  const loadPending = async (id: string): Promise<Pending | undefined> => {
    if (loadedById.has(id)) return loadedById.get(id);

    const state = await load(id, deps);
    loadedById.set(id, state);
    return state;
  };

  /** The create/merge step, shared by items decided on sight and by the model. */
  const absorb = async (item: AnalyzedItem, key: MatchKey, matchId: string | undefined) => {
    const state =
      matchId === undefined ? undefined : (pending.get(matchId) ?? (await loadPending(matchId)));

    if (matchId !== undefined && state === undefined) {
      throw new Error(`matched message ${matchId} disappeared between query and read`);
    }

    if (state !== undefined) {
      // The cap rejects only a *new* member, so a replay still merges.
      // Returning drops the item.
      if (Object.keys(state.members).length >= MAX_MEMBERS && !(item.id in state.members)) {
        deps.metrics.count("MemberCapReached", 1);
        return;
      }
    }

    // An existing member keeps its original `ts`.
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
          }
        : {
            ...state,
            key: unionMatchKeys(state.key, key),
            members: { ...state.members, [item.id]: block },
            addedMembers: { ...state.addedMembers, [item.id]: block },
            // Item side first, so a replay is a fixed point.
            tags: mergeTags(item.tags, state.tags),
            // `??` keeps an empty-string image.
            image: state.image ?? item.image,
            // The newest item's descriptive fields overwrite.
            title: item.title,
            category: item.category,
            country: item.country,
            location: item.location,
            peoples: item.peoples,
          };

    deps.metrics.count(state === undefined ? "MessagesCreated" : "MessagesMerged", 1);

    pending.set(next.id, next);
    if (!toPublish.includes(next.id)) toPublish.push(next.id);
  };

  const deferred: Deferred[] = [];

  for (const { item, key } of keyed) {
    /**
     * The replay short-circuit, ahead of every comparison. An item already in a
     * same-date message's `memberIds` belongs there by identity: later members
     * overwrite the fields, so re-scoring it could split a published story and
     * post it twice. When the candidate is in `pending`, `absorb` uses that
     * fresher copy.
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

    /**
     * Scored against a MESSAGE's key (the union over its members), while the
     * calibration sweep scores item against item. See docs/telegator.md §5.
     */
    let best: Best | undefined;
    const better = (candidate: Best) => {
      // Any improvement counts; the threshold is applied after both passes.
      if (best === undefined || candidate.score > best.score) best = candidate;
    };

    // Pass 1 — messages touched earlier in this batch.
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
     * Pass 2 — stored messages on the same date. Both passes run and the
     * highest score wins, so the model never sees a pair while a closer one
     * goes unexamined.
     */
    if (item.date !== "") {
      for (const candidate of await candidatesFor(item.date)) {
        // The batch already holds a fresher copy of this message.
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
      // At most one pair per item: its best candidate. The pair is built after
      // the loop, because describing the candidate needs a read.
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
    // `=== true`: an unanswered pair splits, as on a failed call.
    await absorb(
      entry.item,
      entry.key,
      verdicts.get(entry.pairId) === true ? entry.candidate.id : undefined,
    );
  }

  deps.metrics.count("DedupCandidateCount", candidateCount);

  const now = deps.clock.now();
  const writes = [...pending.values()].map((state) => toWrite(state, now));

  // A merge that changed nothing a reader would see is not published again.
  // Checked on the final state, since a middle state can differ.
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
 * One call for the batch. A false merge is the costlier error, so a throw, a
 * timeout or a refusal returns no verdicts and every pair splits — never
 * merges, and never fails the batch.
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
 * What crosses the model boundary: English fields only, never `summary` or
 * `body`. `entities` and `tags` come from the match key; `title`, `category`
 * and `location` are the record's own. The key-derived title is a poor
 * fallback, since `titleTokens` is sorted and has no word order.
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
 * The candidate's side of a band pair, from the full message. The date query
 * has no `title`, `category` or `location`, and the key alone would give the
 * model the same sets `matchScore` could not decide on.
 *
 * A message that cannot be read falls back to the key-derived form: a weaker
 * verdict beats a failed batch. `absorb` reads through the same memo, so a real
 * read failure still fails the batch on a merge.
 */
async function bandFieldsOf(
  candidate: Best,
  pending: ReadonlyMap<string, Pending>,
  loadPending: (id: string) => Promise<Pending | undefined>,
): Promise<AdjudicationFields> {
  // A message this batch already touched is fresher than Firestore and needs no read.
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

/** A date-query candidate carries no members, so read the full message. */
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
    tags: message.tags ?? [],
    image: message.image,
    title: message.title,
    category: message.category,
    country: message.country,
    location: message.location,
    peoples: message.peoples,
  };
}

/**
 * The fields publish renders: member blocks, header and hashtags. The match key
 * is absent: it changes on every merge and no reader sees it.
 */
interface PublishedContent {
  readonly members: string;
  readonly title: string | undefined;
  readonly category: string | undefined;
  readonly country: string | undefined;
  readonly location: string | undefined;
  readonly peoples: string | undefined;
  /** Serialised, so the comparison is by value. */
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
  tags?: readonly string[];
  image?: string;
}): PublishedContent => ({
  members: JSON.stringify(message.members),
  title: message.title,
  category: message.category,
  country: message.country,
  location: message.location,
  peoples: message.peoples,
  tags: JSON.stringify(message.tags ?? []),
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
    /** The three key fields the date query scores on, from the union `absorb` kept. */
    ...matchKeyAttributes(state.key),
    /** `state.members` is the complete member map, so its keys are `memberIds` by construction. */
    memberIds: Object.keys(state.members),
    date: state.date,
    title: state.title,
    category: state.category,
    country: state.country,
    location: state.location,
    peoples: state.peoples,
    tags: state.tags,
    image: state.image,
    ts,
    // Omitted when the merge changes nothing rendered, so a replayed message
    // stays `published` instead of being edited with its own text.
    ...(changedPublishedContent(state) ? { status: "topublish" } : {}),
  } satisfies MessageMergeAttributes;

  if (state.isNew) {
    // A create always publishes; `shared.status` is conditional only for merges.
    return {
      kind: "create",
      // `posts` is filled by publish; a merge never writes it.
      message: { id: state.id, members: state.members, posts: {}, ...shared, status: "topublish" },
    };
  }

  // Field by field, so `posts`, which publish owns, is untouched. Every member
  // this batch added is SET, not just the last.
  return {
    kind: "merge",
    merge: { id: state.id, members: state.addedMembers, attributes: shared },
  };
}
