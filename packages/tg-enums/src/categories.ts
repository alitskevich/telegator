import { z } from "zod";

/**
 * The classification categories. The model's output is constrained to this
 * enum, so a missing category forces the classifier into `other`.
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
 * Analyze drops items in this category (`ItemsSkipped`, by `category`).
 *
 * Typed `string` because it is not a `Category`: the model cannot return it, so
 * the rule never fires. It is kept as written and pinned by a test, because
 * changing it changes what gets published.
 */
export const DROPPED_CATEGORY: string = "crime&law";
