import { z } from "zod";
import { DateKeySchema } from "./date.js";
import { ItemIdSchema } from "./ids.js";

/**
 * The in-flight item — an SQS payload, never a table row (§2.2 L115, §1.3 L42).
 *
 * It exists in two shapes: Stage A leaves `scrape` for the analyze queue
 * (§2.2 L120–130), and Stage B leaves `analyze` for the aggregate queue
 * (§2.2 L132), adding the AI fields of §5.2 L441–453.
 */

/** §12.2 L884 and §5.2 L455 — the source prompt's 60-symbol cap, raised to 220. */
export const SUMMARY_MAX_LENGTH = 220;

/** §2.2 L130 — replaces the source system's initial `status` value. */
export const ITEM_KINDS = ["post", "forward", "empty"] as const;

export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

/** §2.2 L123 — resolves a `[text](#N)` token produced by §3.1 L203. */
export const LinkSchema = z.object({
  id: z.number().int().positive(),
  href: z.string(),
});

export type Link = z.infer<typeof LinkSchema>;

export const ScrapedItemSchema = z.object({
  id: ItemIdSchema,
  /** Plain text with inline links replaced by `[text](#N)` tokens (§2.2 L122). */
  body: z.string(),
  links: z.array(LinkSchema).default([]),
  image: z.string().optional(),
  forwardedFrom: z.string().optional(),
  /** Copied from the source; §6 L536 falls back to `telegator_news` when absent. */
  tgChannel: z.string().optional(),
  date: DateKeySchema,
  /** The source default, overwritten by AI (§2.2 L128) — an open string, since an
   * operator's default need not be one of §5.4's categories. */
  category: z.string().optional(),
  tags: z.string().optional(),
  kind: ItemKindSchema,
});

export type ScrapedItem = z.infer<typeof ScrapedItemSchema>;

/**
 * The AI fields, declared once. §5.2 L441 fixes which are required.
 *
 * `category` is an open string here rather than §5.4's enum: item 2.13 narrows
 * it to `CategorySchema` for the model-response schema, where the constraint
 * belongs. Constraining it here as well would duplicate the enum.
 */
const aiField = {
  /** Essential subject in three words, English (§5.2 L445). */
  title: z.string(),
  /** Brief factual matter, in Belarusian, with `[text](#N)` tokens intact (§5.2 L446). */
  summary: z.string().max(SUMMARY_MAX_LENGTH),
  /** ISO-3166 alpha-2 (§5.2 L447). Case is normalised by §3.2 L244, not here. */
  country: z.string(),
  location: z.string(),
  category: z.string(),
  importance: z.enum(["high", "low"]),
  peoples: z.string().optional(),
  properNames: z.string().optional(),
  tags: z.string().optional(),
} as const;

/** The model's response shape (§5.2 L441–453). */
export const AiFieldsSchema = z.object(aiField);

export type AiFields = z.infer<typeof AiFieldsSchema>;

/**
 * Stage B — everything from Stage A plus the AI fields (§2.2 L132).
 *
 * Built with `.extend()` rather than merging `AiFieldsSchema` wholesale, so the
 * model's optional `tags` cannot weaken Stage A's own `tags`, and so `category`
 * keeps Stage A's meaning. §3.2 L244 merges tags rather than replacing them.
 */
export const AnalyzedItemSchema = ScrapedItemSchema.extend({
  title: aiField.title,
  summary: aiField.summary,
  /**
   * AC-2.4 (L253): "`country` is always uppercase or empty." Asserted rather
   * than transformed — a Zod `.toUpperCase()` here would make the criterion
   * unfalsifiable at the stage that is supposed to satisfy it (§3.2 L244).
   */
  country: aiField.country.refine((v) => v === v.toUpperCase(), "expected an uppercase country"),
  location: aiField.location,
  importance: aiField.importance,
  peoples: aiField.peoples,
  properNames: aiField.properNames,
});

export type AnalyzedItem = z.infer<typeof AnalyzedItemSchema>;
