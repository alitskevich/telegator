import { ImportanceSchema, ItemKindSchema } from "tg-enums/itemKind";
import { z } from "zod";
import { DateKeySchema } from "./date";
import { ItemIdSchema } from "./ids";
import { TagsSchema } from "./tags";

/**
 * The post in flight: the `raw` of an `ingest` item, not a record of its own
 * (docs/telegator.md §2). Scrape sends the scraped shape to analyze, and
 * analyze adds the AI fields before sending it to aggregate.
 */

/** The summary length cap. */
export const SUMMARY_MAX_LENGTH = 220;

/** Resolves a `[text](#N)` token in the body. */
export const LinkSchema = z.object({
  id: z.number().int().positive(),
  href: z.string(),
});

export type Link = z.infer<typeof LinkSchema>;

export const ScrapedItemSchema = z.object({
  id: ItemIdSchema,
  /** Plain text with inline links replaced by `[text](#N)` tokens. */
  body: z.string(),
  links: z.array(LinkSchema).default([]),
  image: z.string().optional(),
  forwardedFrom: z.string().optional(),
  date: DateKeySchema,
  /** The source default, overwritten by AI. An open string, since an operator's
   * default need not be a known category. */
  category: z.string().optional(),
  /** The source's tags; analyze merges the AI's in. */
  tags: TagsSchema.optional(),
  kind: ItemKindSchema,
});

export type ScrapedItem = z.infer<typeof ScrapedItemSchema>;

/**
 * The AI fields, declared once. `category` is an open string here; the model
 * response schema narrows it to `CategorySchema`, where the constraint belongs.
 */
const aiField = {
  /** Essential subject in three words, English. */
  title: z.string(),
  /** Brief factual matter, in Belarusian, with `[text](#N)` tokens intact. */
  summary: z.string().max(SUMMARY_MAX_LENGTH),
  /** ISO-3166 alpha-2. Analyze uppercases it, not this schema. */
  country: z.string(),
  location: z.string(),
  category: z.string(),
  importance: ImportanceSchema,
  peoples: z.string().optional(),
  properNames: z.string().optional(),
  tags: z.array(z.string()).optional(),
} as const;

/** The model's response shape. */
export const AiFieldsSchema = z.object(aiField);

export type AiFields = z.infer<typeof AiFieldsSchema>;

/**
 * The scraped item plus the AI fields. Built with `.extend()` rather than merging
 * `AiFieldsSchema`, so the model's optional `tags` and open `category` cannot
 * replace the scraped ones: analyze merges tags rather than replacing them.
 */
export const AnalyzedItemSchema = ScrapedItemSchema.extend({
  title: aiField.title,
  summary: aiField.summary,
  /** Asserted rather than transformed, so a stage that forgets to uppercase fails. */
  country: aiField.country.refine((v) => v === v.toUpperCase(), "expected an uppercase country"),
  location: aiField.location,
  importance: aiField.importance,
  peoples: aiField.peoples,
  properNames: aiField.properNames,
});

export type AnalyzedItem = z.infer<typeof AnalyzedItemSchema>;
