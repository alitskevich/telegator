import { z } from "zod";

/**
 * The classification categories of §5.4, L494–501, verbatim and in document
 * order.
 *
 * R4 — 29 entries, where earlier drafts asserted 35 and the six missing names
 * were not recoverable. It matters beyond arithmetic: §5.2 L427 constrains model
 * output to this enum, so a wrong list makes a legitimate category unsayable and
 * forces the classifier into `other`, degrading §3.2's routing silently.
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
 * The literal §3.2 L253 routes on: `category === "crime&law"` → drop, metric
 * `ItemsSkipped{Reason=category}`.
 *
 * R5 — typed `string`, not `Category`, because it is **not** one of §5.4's
 * values. §5.2 L427 constrains model output to that enum, so `crime&law` is
 * unsayable: the drop rule can never fire and crime content is published.
 *
 * §3.2 is the normative stage spec, so the rule ships exactly as written and the
 * mismatch is pinned by test rather than silently corrected — changing this
 * string changes what reaches production channels, which is the owner's call.
 */
export const DROPPED_CATEGORY: string = "crime&law";
