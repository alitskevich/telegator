import { createOpenRouterAdjudicator } from "../lib/ai/adjudicator";
import {
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_MODEL_ID,
  OPENROUTER_BASE_URL,
} from "../lib/ai/constants";
import { createOpenRouterClassifier } from "../lib/ai/openrouter";

/**
 * R50 — the smoke test for the OpenRouter swap.
 *
 * **Why this is a script and not a test.** None of the four gates can watch a
 * model call happen: `vitest` forbids the network outright, and `tsc`, `biome`
 * and `cdk synth` never execute a request. So the swap's real failure modes —
 * a base URL that composes to the wrong path, an auth header the provider does
 * not recognise, an `output_config` the tier rejects — all pass every gate
 * against an adapter that cannot classify a single item. This file is the thing
 * that would have caught them.
 *
 * Unlike `seed.ts`, the logic is *not* pushed down into `lib/`: what is being
 * checked here is the behaviour of the real SDK against a real socket, which is
 * precisely the part `lib/` is built to keep out of the test process.
 *
 * ```
 * npm run smoke:openrouter           # offline — canned far end, no network, no key
 * npm run smoke:openrouter -- --live # one real call; needs OPENROUTER_API_KEY
 * ```
 *
 * Offline mode replaces `globalThis.fetch` before any client is constructed, so
 * the adapter, the SDK, the base URL, the key handling and the request body are
 * all the real ones — only the far end is canned.
 */

const API_KEY_VAR = "OPENROUTER_API_KEY";

/** A response that satisfies `NewsItemSchema`; `category` is from §5.4's enum. */
const CANNED_ITEM = {
  title: "Explosion reported at a Minsk substation",
  summary: "Паведамляецца пра выбух на падстанцыі ў Мінску.",
  country: "BY",
  location: "Minsk",
  category: "geopolitics",
  importance: "high",
};

const ITEM_BODY =
  "У Мінску на падстанцыі стаўся выбух, ёсць пацярпелыя. Рух транспарту абмежаваны.";

interface Capture {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const passed: string[] = [];
const failed: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  (ok ? passed : failed).push(detail === "" ? name : `${name} — ${detail}`);
}

/**
 * Normalises whatever shape `fetch` was handed.
 *
 * The SDK passes a `Headers` instance, never a plain object — `Object.entries`
 * on one yields nothing, and the first run of this script "proved" the adapter
 * sent no auth header at all when in fact it sent `x-api-key`.
 */
function readHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};

  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw as [string, string][]) {
      headers[String(key).toLowerCase()] = String(value);
    }
  } else {
    for (const [key, value] of Object.entries((raw ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
  }

  return headers;
}

/** Installs a fake far end and returns the capture slot it writes into. */
function interceptFetch(text: () => string): { current?: Capture } {
  const slot: { current?: Capture } = {};

  globalThis.fetch = (async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
    slot.current = {
      url: typeof input === "string" ? input : String((input as { url?: string })?.url ?? input),
      headers: readHeaders(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    };

    return new Response(
      JSON.stringify({
        id: "msg_smoke",
        type: "message",
        role: "assistant",
        model: CLASSIFIER_MODEL_ID,
        content: [{ type: "text", text: text() }],
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return slot;
}

function adjudicationFields(title: string) {
  return {
    title,
    entities: ["Minsk"],
    tags: ["energy"],
    category: "geopolitics",
    location: "Minsk",
    date: "2026-09-06",
  };
}

async function runOffline(): Promise<void> {
  console.log(`offline — canned far end, no network. Base URL: ${OPENROUTER_BASE_URL}\n`);

  const slot = interceptFetch(() => JSON.stringify(CANNED_ITEM));

  let keyReads = 0;
  const classifier = createOpenRouterClassifier({
    apiKey: async () => {
      keyReads += 1;
      return "sk-or-v1-smoke-key";
    },
  });

  const item = await classifier.classify(ITEM_BODY);
  const sent = slot.current;
  const body = sent?.body ?? {};
  const outputConfig = (body.output_config ?? {}) as {
    effort?: string;
    format?: { type?: string };
  };

  check(
    "POSTs to the Messages endpoint",
    sent?.url === `${OPENROUTER_BASE_URL}/v1/messages`,
    sent?.url,
  );
  check("no doubled version segment", !String(sent?.url).includes("/v1/v1"));
  check(
    "sends the key as an auth header",
    sent?.headers["x-api-key"] === "sk-or-v1-smoke-key" ||
      sent?.headers.authorization === "Bearer sk-or-v1-smoke-key",
    `headers: ${Object.keys(sent?.headers ?? {})
      .filter((h) => !h.startsWith("x-stainless"))
      .join(", ")}`,
  );
  check("model is the OpenRouter slug", body.model === CLASSIFIER_MODEL_ID, String(body.model));
  check("carries output_config.format json_schema", outputConfig.format?.type === "json_schema");
  check("carries output_config.effort", outputConfig.effort === "low", String(outputConfig.effort));
  check("carries the system prompt", typeof body.system === "string");
  check("max_tokens is the configured value", body.max_tokens === CLASSIFIER_MAX_TOKENS);
  check("response parsed through NewsItemSchema", item.category === "geopolitics");
  check("read the key exactly once", keyReads === 1, `${keyReads} read(s)`);

  await classifier.classify("Другое паведамленне.");
  check("reuses the client across calls", keyReads === 1, `${keyReads} read(s)`);

  const verdictSlot = interceptFetch(() =>
    JSON.stringify({ verdicts: [{ id: "p1", same: true }] }),
  );
  const verdicts = await createOpenRouterAdjudicator({
    apiKey: async () => "sk-or-v1-smoke-key",
  }).adjudicate([
    {
      id: "p1",
      item: adjudicationFields("Blast at a Minsk substation"),
      candidate: adjudicationFields("Explosion hits Minsk power site"),
    },
  ]);

  check("adjudicator returns a verdict keyed by pair id", verdicts.get("p1") === true);
  check(
    "adjudicator posts to the same endpoint",
    String(verdictSlot.current?.url).endsWith("/v1/messages"),
  );

  try {
    await createOpenRouterClassifier().classify(ITEM_BODY);
    check("missing key is named, not swallowed", false, "did not throw");
  } catch (error) {
    check("missing key is named, not swallowed", /OpenRouter API key/.test(String(error)));
  }
}

async function runLive(apiKey: string): Promise<void> {
  console.log(`live — one real call to ${OPENROUTER_BASE_URL} as ${CLASSIFIER_MODEL_ID}\n`);

  // With effort, which is what the pipeline actually sends. R3 could not
  // establish whether the tier accepts it; this is the call that finds out.
  try {
    const item = await createOpenRouterClassifier({ apiKey: async () => apiKey }).classify(
      ITEM_BODY,
    );
    check(
      "a real classification returns a schema-valid NewsItem",
      true,
      `category=${item.category}`,
    );
    check("output_config.effort is accepted by this tier (R3)", true);
    console.log(`\n  model returned: ${JSON.stringify(item, null, 2).replace(/\n/g, "\n  ")}\n`);
  } catch (error) {
    const message = String(error);
    check("a real classification returns a schema-valid NewsItem", false, message);

    // A 400 naming the field is R3's escape hatch becoming necessary, not an outage.
    if (/effort/i.test(message)) {
      console.log("\n  → the tier rejects `output_config.effort`. Pass `effort: false` in");
      console.log(
        "    `handlers/analyze.ts`, which `buildClassificationRequest` already supports.\n",
      );
    }
  }
}

async function main(): Promise<void> {
  const live = process.argv.slice(2).includes("--live");
  const apiKey = process.env[API_KEY_VAR];

  if (live && (apiKey === undefined || apiKey === "")) {
    console.error(`--live needs ${API_KEY_VAR} in the environment.`);
    process.exit(2);
  }

  if (live && apiKey !== undefined) {
    await runLive(apiKey);
  } else {
    await runOffline();
  }

  if (passed.length > 0) console.log("PASS");
  for (const name of passed) console.log(`  ✓ ${name}`);
  if (failed.length > 0) {
    console.log("\nFAIL");
    for (const name of failed) console.log(`  ✗ ${name}`);
  }
  console.log(`\n${passed.length} passed, ${failed.length} failed`);

  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
