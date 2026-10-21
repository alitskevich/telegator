import { OPENROUTER_BASE_URL } from "tg-configs/ai";
import type { MessagesClient } from "./types";

/**
 * The one place a real model client is built, shared by both adapters. The SDK
 * import is lazy, so tests can import the adapters without loading it.
 */

/** Supplies the OpenRouter API key. Injected, so `tg-ai` does not decide where the secret lives. */
export type ApiKeyProvider = () => Promise<string>;

/** Builds the OpenRouter-backed Messages client. The SDK appends `/v1/messages` to `baseURL`. */
export async function createMessagesClient(apiKey: ApiKeyProvider): Promise<MessagesClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ baseURL: OPENROUTER_BASE_URL, apiKey: await apiKey() });

  // `as never`: the SDK's request type does not declare `output_config` as sent
  // here. The cast stays at this boundary; `ClassificationRequest` is the typed shape.
  return { create: (request) => client.messages.create(request as never) };
}

/**
 * The error both adapters raise with neither a client nor a key provider. It
 * reads as a wiring fault, not a provider outage that retries would hide.
 */
export function missingApiKey(source: string): Error {
  return new Error(`${source} has no OpenRouter API key provider; the handler must supply one`);
}
