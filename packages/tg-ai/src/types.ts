import type { ErrorDiagnosis } from "tg-domain/ingest";
import type { NEWS_ITEM_SCHEMA, NewsItem } from "tg-domain/newsItemSchema";
import type { ApiKeyProvider } from "./openrouterClient";

/** Classifies one post. Throws on a provider error, so the task retries. */
export interface Classifier {
  classify(body: string): Promise<NewsItem>;
}

/** The English structured fields a dedup pair is judged on; source text never crosses. */
export interface AdjudicationFields {
  readonly title: string;
  readonly entities: readonly string[];
  readonly tags: readonly string[];
  readonly category: string | undefined;
  readonly location: string | undefined;
  readonly date: string;
}

export interface AdjudicationPair {
  /** Verdicts come back keyed by this, never positionally. */
  readonly id: string;
  readonly item: AdjudicationFields;
  readonly candidate: AdjudicationFields;
}

/** Decides the ambiguous dedup pairs: `true` means same story. */
export interface Adjudicator {
  adjudicate(pairs: readonly AdjudicationPair[]): Promise<ReadonlyMap<string, boolean>>;
}

export interface AdjudicatorClient {
  create(request: unknown): Promise<unknown>;
}

export interface OpenRouterAdjudicatorOptions {
  readonly client?: AdjudicatorClient;
  /** Reads the key from the function secret; supplied by `tg-functions/src/index.ts`. */
  readonly apiKey?: ApiKeyProvider;
}

/** What the diagnoser is shown of one failed `ingest` item. */
export interface ErrorReport {
  readonly stage: string;
  readonly error: string;
  readonly cause: string | undefined;
  readonly attempts: number;
  /** The payload as JSON, cut to a size the model reads cheaply. */
  readonly payload: string;
}

/** Reads a failed item and proposes a fix. Throws on a provider error. */
export interface Diagnoser {
  diagnose(report: ErrorReport): Promise<ErrorDiagnosis>;
}

export interface OpenRouterDiagnoserOptions {
  readonly client?: AdjudicatorClient;
  /** Reads the key from the function secret; supplied by `tg-api`. */
  readonly apiKey?: ApiKeyProvider;
}

/** `schema` is typed from `NEWS_ITEM_SCHEMA`, so the JSON Schema has one definition. */
export interface ClassificationOutputFormat {
  readonly type: "json_schema";
  readonly schema: typeof NEWS_ITEM_SCHEMA;
}

export interface ClassificationOutputConfig {
  /** Absent when disabled, never present-and-undefined. */
  readonly effort?: string;
  readonly format: ClassificationOutputFormat;
}

export interface ClassificationMessage {
  readonly role: "user";
  readonly content: string;
}

/**
 * The classification request body. No `temperature` or `top_p`: current Claude
 * models reject them with 400. Depth is `output_config.effort` instead.
 */
export interface ClassificationRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly output_config: ClassificationOutputConfig;
  readonly system: string;
  readonly messages: readonly ClassificationMessage[];
}

export interface ClassificationRequestOptions {
  /** `false` omits `output_config.effort`, for a model tier that does not accept it. */
  readonly effort?: string | false;
}

/** Kept as a named export because the tests inject against exactly this shape. */
export interface ClassifierClient {
  create(request: ClassificationRequest): Promise<unknown>;
}

export interface OpenRouterClassifierOptions {
  readonly client?: ClassifierClient;
  /** Reads the key from the function secret; supplied by `tg-functions/src/index.ts`. */
  readonly apiKey?: ApiKeyProvider;
  /** `false` omits `output_config.effort` entirely. */
  readonly effort?: ClassificationRequestOptions["effort"];
}

/**
 * The slice of the Anthropic client the adapters use. A structural type, so
 * test fakes satisfy it without constructing a real client and its API key.
 */
export interface MessagesClient {
  create(request: unknown): Promise<unknown>;
}
