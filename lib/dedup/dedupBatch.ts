import type { EmbeddingProvider } from "../ai/ports";
import type { Clock } from "../clock";
import { packEmbedding, unpackEmbedding } from "../db/embeddingCodec";
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
import type { MetricSink } from "../metrics/ports";
import { DIMENSIONS, MAX_MEMBERS, SIMILARITY_THRESHOLD } from "./constants";
import { cosineSimilarity } from "./cosine";
import { buildEmbeddingText } from "./embeddingText";
import { elementwiseMean } from "./vectors";

/**
 * The normative deduplication algorithm of §6 (L488–553).
 *
 * Pure: it performs no table write and enqueues nothing. §6 L547–552 leave both
 * to the caller, and keeping them out is what makes the whole of §6 testable
 * with no AWS at all.
 *
 * Four recorded reconciliations are implemented here rather than transcribed:
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
 */

export interface DedupDeps {
  readonly embeddings: EmbeddingProvider;
  /** §6 L515 — the `date-index` query. */
  loadCandidatesByDate(date: string): Promise<DedupCandidate[]>;
  /** R9 — the base-table read that supplies the members a candidate lacks. */
  loadMessage(id: string): Promise<Message | undefined>;
  readonly clock: Clock;
  readonly metrics: MetricSink;
  /**
   * §11.3 L864 requires the threshold to be recalibrated against Cohere before
   * production. Injected so that is a configuration change, not a code edit.
   */
  readonly similarityThreshold?: number;
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
  embedding: number[];
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

export async function dedupBatch(
  batch: readonly AnalyzedItem[],
  deps: DedupDeps,
): Promise<DedupResult> {
  if (batch.length === 0) {
    return { writes: [], toPublish: [], candidateCount: 0 };
  }

  const threshold = deps.similarityThreshold ?? SIMILARITY_THRESHOLD;

  // §6 L495–497 — one text per item, one provider call for the batch.
  const vectors = await deps.embeddings.embedBatch(batch.map(buildEmbeddingText), DIMENSIONS);

  const pending = new Map<string, Pending>();
  const toPublish: string[] = [];
  // All items in a batch share one date (§7.3 L607's FIFO group), and nothing is
  // written until the caller applies the result — so §6 L515's per-item query
  // returns the same rows every time. Caching it is what §6 L557's own cost
  // model ("10 items x 200 candidates is 2,000 comparisons") already assumes.
  const candidatesByDate = new Map<string, DedupCandidate[]>();
  let candidateCount = 0;

  for (const [index, item] of batch.entries()) {
    const vec = vectors[index];
    if (vec === undefined) {
      throw new Error(`embedding provider returned no vector for item ${item.id}`);
    }

    // Pass 1 — messages touched earlier in this batch (§6 L505–511).
    let best: Pending | undefined;
    let bestScore = 0;
    for (const candidate of pending.values()) {
      if (candidate.embedding.length === 0 || candidate.date !== item.date) continue;
      const score = cosineSimilarity(vec, candidate.embedding);
      // L510 records any improvement, with no threshold test.
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    let matchId = best !== undefined && bestScore >= threshold ? best.id : undefined;

    // Pass 2 — stored messages on the same date (§6 L513–519).
    if (matchId === undefined && item.date !== "") {
      let candidates = candidatesByDate.get(item.date);
      if (candidates === undefined) {
        candidates = await deps.loadCandidatesByDate(item.date);
        candidatesByDate.set(item.date, candidates);
        candidateCount += candidates.length;
      }

      for (const candidate of candidates) {
        // R10 — the batch already holds a fresher copy of this message.
        if (pending.has(candidate.id)) continue;
        if (candidate.embedding === undefined || candidate.embedding.byteLength === 0) continue;

        const score = cosineSimilarity(vec, unpackEmbedding(candidate.embedding));
        if (score >= threshold && score > bestScore) {
          bestScore = score;
          matchId = candidate.id;
        }
      }
    }

    const state =
      matchId === undefined ? undefined : (pending.get(matchId) ?? (await load(matchId, deps)));

    if (matchId !== undefined && state === undefined) {
      throw new Error(`matched message ${matchId} disappeared between query and read`);
    }

    if (state !== undefined) {
      // §6 L525–526 — the cap rejects only a *new* key, so a replay of an item
      // already present still merges. `continue` drops the item outright: no
      // message is created for it and nothing is enqueued.
      if (Object.keys(state.members).length >= MAX_MEMBERS && !(item.id in state.members)) {
        deps.metrics.count("MemberCapReached", 1);
        continue;
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
            embedding: vec,
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
            embedding: elementwiseMean(state.embedding, vec),
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

/** R9 — a `date-index` candidate carries no members, so read the base record. */
async function load(id: string, deps: DedupDeps): Promise<Pending | undefined> {
  const message = await deps.loadMessage(id);
  if (message === undefined) return undefined;

  return {
    id: message.id,
    date: message.date,
    isNew: false,
    origin: publishedContentOf(message),
    embedding: message.embedding === undefined ? [] : unpackEmbedding(message.embedding),
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
 * `embedding` is deliberately absent. §6 L559's centroid drift changes it on
 * every replay and no reader ever sees it, so including it would make every
 * merge look like a change and the comparison pointless.
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
    embedding: packEmbedding(state.embedding),
    /**
     * R44 — `Pending` does not track a match key yet: this task only adds the
     * storage for one, and Task 5 is what computes it from the batch's items
     * and unions it across a merge (§6 L488–553's rewrite). Writing `[]` here
     * is indistinguishable from a legacy record with no key at all — an empty
     * key that cannot match anything — so it is a safe placeholder rather than
     * a behaviour change.
     */
    keyEntities: [] as string[],
    keyTitle: [] as string[],
    keyTags: [] as string[],
    /**
     * R51 — unlike the match key, this needs no new algorithm: `state.members`
     * is already the message's complete, up-to-date member map on both the
     * create and the merge branch below, so its keys are `memberIds` by
     * construction. Kept in lockstep with `members` for exactly that reason.
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
