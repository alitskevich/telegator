import type { Adjudicator } from "tg-ai/types";
import type {
  DedupCandidate,
  MemberBlock,
  Message,
  MessageMergeAttributes,
} from "tg-domain/message";
import type { Metrics } from "tg-enums/types";
import type { Clock, Logger } from "tg-utils/types";
import type { DedupWrite } from "./dedupBatch";

export interface DedupDeps {
  /** Resolves the ambiguous band. Called at most once per batch, and not at all when the band is empty. */
  readonly adjudicator: Adjudicator;
  /** The same-date Firestore query; it returns key fields only. */
  loadCandidatesByDate(date: string): Promise<DedupCandidate[]>;
  /**
   * Reads the full message: the `members` a merge needs, and the `title`,
   * `category` and `location` a band pair describes it with. Memoised per batch.
   */
  loadMessage(id: string): Promise<Message | undefined>;
  readonly clock: Clock;
  readonly metrics: Metrics;
  /**
   * An adjudication failure is swallowed, because splitting is the safe outcome.
   * The metric records that it happened; the log records *why*.
   */
  readonly logger: Logger;
  /** Injected, so recalibration is a configuration change rather than a code edit. */
  readonly band?: Band;
}

/** A merge written attribute-level: one `members.{itemId}` per member, plus the scalars. */
export interface MemberMerge {
  readonly id: string;
  readonly members: Readonly<Record<string, MemberBlock>>;
  readonly attributes: MessageMergeAttributes;
}

export interface DedupResult {
  readonly writes: readonly DedupWrite[];
  /** Every touched message id whose rendered content changed. */
  readonly toPublish: readonly string[];
  /** Recorded as a metric: a large count means the in-memory comparison is getting costly. */
  readonly candidateCount: number;
}

/**
 * The deduplication match key, built only from the fields the classifier emits
 * in English: `title`, `peoples`, `properNames`, `tags`.
 *
 * Every array is lowercased, punctuation-stripped, deduplicated and sorted, so
 * an identical item serialises to identical bytes. Byte-identical replay
 * depends on that.
 */
export interface MatchKey {
  readonly entities: readonly string[];
  readonly titleTokens: readonly string[];
  readonly tags: readonly string[];
}

/**
 * A structural shape rather than `AnalyzedItem`, so the calibration harness can
 * pass labelled-set records without building a full queue payload.
 */
export interface MatchKeyFields {
  readonly title?: string | undefined;
  readonly peoples?: string | undefined;
  readonly properNames?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface ScoreWeights {
  readonly entities: number;
  readonly titleTokens: number;
  readonly tags: number;
}

export interface Band {
  readonly merge: number;
  readonly distinct: number;
}
