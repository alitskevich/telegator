import { OPENROUTER_BASE_URL } from "./constants";

/**
 * R50 — the one place a real model client is constructed.
 *
 * Both adapters (`./openrouter` and `./adjudicator`) build one from here rather
 * than each holding its own copy: the client needs a *secret*, and two copies
 * would be two places for the base URL, the key handling and the lazy import to
 * drift apart.
 *
 * The import stays lazy so that loading this module does not pull the SDK in,
 * and a test process can import the adapters without an SDK ever reaching for
 * credentials.
 */

/**
 * The slice of the Anthropic client the adapters use.
 *
 * A structural type rather than the SDK class: it keeps the fakes in the tests
 * honest — they must satisfy the same shape the real client does — without a
 * test process constructing an `Anthropic`, which under OpenRouter would demand
 * an API key the build machine has no business holding.
 */
export interface MessagesClient {
  create(request: unknown): Promise<unknown>;
}

/**
 * Supplies the OpenRouter API key.
 *
 * Async and injected rather than read from the environment, because §7.6 keeps
 * it in Secrets Manager: the handler owns the fetch and its caching (the same
 * arrangement `lib/telegram/bot.ts` has with `tokenProvider`), and `lib/` stays
 * free of both the AWS SDK and the decision about where a secret lives.
 */
export type ApiKeyProvider = () => Promise<string>;

/**
 * Builds the OpenRouter-backed Messages client.
 *
 * `baseURL` stops at `/api` because the SDK appends `/v1/messages` itself
 * (§5.1) — the request path is not spelled out here, so an SDK that changes it
 * keeps working.
 */
export async function createMessagesClient(apiKey: ApiKeyProvider): Promise<MessagesClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ baseURL: OPENROUTER_BASE_URL, apiKey: await apiKey() });

  // `as never`: §5.2 L425-427's `output_config` is an OpenRouter extension the
  // SDK's own request type does not declare. The cast is at the boundary and
  // nowhere else — `ClassificationRequest` remains the typed definition of what
  // goes on the wire.
  return { create: (request) => client.messages.create(request as never) };
}

/**
 * The error both adapters raise when they are asked to call a model with
 * neither an injected client nor a key provider.
 *
 * Named here so the two adapters cannot word it differently, and so it reads as
 * a wiring fault rather than a provider outage: §3.2 L258 routes provider
 * errors to SQS retry, and retrying a missing dependency for six hours before
 * the DLQ would hide the real cause behind a full DLQ.
 */
export function missingApiKey(source: string): Error {
  return new Error(`${source} has no OpenRouter API key provider; the handler must supply one`);
}
