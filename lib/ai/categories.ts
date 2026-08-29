import { z } from "zod";

/**
 * The classification categories of §5.4, L472–481, verbatim and in document
 * order.
 *
 * R4 — the list is 29 entries. §5.4's heading says "Categories (35)", §5.2 L449
 * says "One of the 35 values in §5.4", and §7.7 L695 reasons from "Thirty-five
 * category dimensions". The block contains 29, and two entries (`human-rights`,
 * `nature`) sit off its four-column grid, which is what removed text leaves
 * behind. The six missing names are not recoverable from this document, so the
 * list the spec actually contains is the list that ships and the discrepancy is
 * recorded rather than guessed at.
 *
 * This matters beyond arithmetic: §5.2 L423 constrains the model's output to
 * this enum, so a wrong list makes a legitimate category unsayable and forces
 * the classifier into `other`, silently degrading the routing §3.2 depends on.
 */
export const CATEGORIES = [
  "art&fashion",
  "crime",
  "culture&history",
  "news-digest",
  "economics&finance",
  "education",
  "energy",
  "entertainment",
  "sports",
  "environmental",
  "geopolitics",
  "health",
  "human-rights",
  "infrastructure",
  "international",
  "media",
  "other",
  "politics",
  "real-estate",
  "science",
  "social",
  "technology",
  "internet",
  "traditions",
  "tourism",
  "traffic",
  "war",
  "incidents",
  "nature",
] as const;

export const CategorySchema = z.enum(CATEGORIES);

export type Category = z.infer<typeof CategorySchema>;

/**
 * The literal §3.2 L241 routes on: `category === "crime&law"` → drop, metric
 * `ItemsSkipped{Reason=category}`.
 *
 * R5 — deliberately typed `string`, not `Category`, because it is **not** one of
 * §5.4's values. §5.2 L423 constrains model output to that enum, so the model
 * cannot emit `crime&law`: the drop rule can never fire, its metric is always
 * zero, and crime content is published. §5.4 does contain a bare `crime`, which
 * is a plausible casualty of whatever edit shortened the block to 29.
 *
 * §3.2 is the normative stage spec, so the rule is implemented exactly as
 * written and the mismatch is pinned by test rather than silently corrected —
 * changing this string changes what reaches production Telegram channels, which
 * is the spec owner's decision.
 */
export const DROPPED_CATEGORY: string = "crime&law";
