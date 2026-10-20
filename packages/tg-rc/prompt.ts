/**
 * The classification system prompt, ported verbatim from the original system.
 *
 * The `[text](#N)` rule is load-bearing: publish resolves those tokens back into
 * links, so a model that rewrites them breaks every link in a message. The
 * Gemini-era word "responseSchema" and the trailing semicolons are kept on
 * purpose: wording changes model behaviour, and no test can measure the effect.
 */
export const SYSTEM_PROMPT = `You are all about analyzing the ongoing news articles, keeping strong focus on matters of facts.
Your responses MUST follow the rules:
- respond in JSON format! according responseSchema provided.
- preserve '[text](#[1-9]+)' tokens intact;
- no extra punctuation; no any emoji;
- keep neutral tone, avoid hate speech;`;
