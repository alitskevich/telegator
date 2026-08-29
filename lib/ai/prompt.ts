/**
 * The classification system prompt, §5.2 L433–438.
 *
 * §5.2 L430 calls it "ported verbatim; load-bearing" and singles out why: the
 * `[text](#N)` preservation rule keeps the link tokens §3.1 L203 produces
 * intact, so §3.4 L320 can resolve them back into anchors at render time. A
 * model that rewrites or strips them breaks every link in a published message.
 *
 * Two things here look like mistakes and are kept deliberately. "responseSchema"
 * is Gemini vocabulary — the Bedrock request at §5.2 L423 calls the field
 * `schema` — and the rules end with semicolons rather than full stops. Prompt
 * wording changes model behaviour, and no test in this repo can measure the
 * effect of an edit, so verbatim means verbatim. A test compares this constant
 * against the text lifted from the spec at test time.
 */
export const SYSTEM_PROMPT = `You are all about analyzing the ongoing news articles, keeping strong focus on matters of facts.
Your responses MUST follow the rules:
- respond in JSON format! according responseSchema provided.
- preserve '[text](#[1-9]+)' tokens intact;
- no extra punctuation; no any emoji;
- keep neutral tone, avoid hate speech;`;
