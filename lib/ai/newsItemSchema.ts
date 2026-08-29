import { z } from "zod";
import { AiFieldsSchema } from "../domain/item.js";
import { CategorySchema } from "./categories.js";

/**
 * The classification response schema, §5.2 L441–453.
 *
 * Derived from the payload's `AiFieldsSchema` (item 2.5) rather than
 * redeclaring nine fields: that module already owns their types, L441's
 * required/optional split and §12.2's 220-character summary cap. Two
 * hand-maintained definitions of the same shape drift.
 *
 * Only `category` differs, and the difference is meaningful. §5.2 L449
 * constrains the model to §5.4's enum, while §2.2 L128 lets the item payload
 * carry an operator's arbitrary source default until AI overwrites it — so the
 * enum belongs here, at the model boundary, and nowhere else.
 *
 * The `.describe()` calls are not documentation. §5.2 L443–453's Description
 * column is the only place the "three words", "In Belarusian" and importance
 * guidance appear anywhere in the spec, and structured output drops them unless
 * they reach the emitted JSON Schema — at which point the model never receives
 * the instruction at all.
 */
export const NewsItemSchema = AiFieldsSchema.extend({
  title: AiFieldsSchema.shape.title.describe("Essential subject in three words, English."),
  summary: AiFieldsSchema.shape.summary.describe(
    "Brief factual matter — no implications, opinions or judgements. In Belarusian.",
  ),
  country: AiFieldsSchema.shape.country.describe("ISO-3166 alpha-2 code."),
  location: AiFieldsSchema.shape.location.describe("City or region, English."),
  category: CategorySchema.describe("One of the categories listed in §5.4."),
  importance: AiFieldsSchema.shape.importance.describe(
    'high | low. "Diminish any of sports, criminal accidents, funny, temporary, and local content."',
  ),
  peoples: AiFieldsSchema.shape.peoples.describe(
    "Comma-separated person names, Latin letters, English.",
  ),
  properNames: AiFieldsSchema.shape.properNames.describe(
    "Comma-separated places, organisations, events, English.",
  ),
  tags: AiFieldsSchema.shape.tags.describe("3–5 related tags, English."),
});

export type NewsItem = z.infer<typeof NewsItemSchema>;

/**
 * The JSON Schema sent as `output_config.format.schema` (§5.2 L423).
 *
 * Generated from the Zod schema, never hand-written — zod 4 emits it natively,
 * so there is one definition and the constraint the model is held to cannot
 * drift from the one this code validates against.
 */
export const NEWS_ITEM_SCHEMA = z.toJSONSchema(NewsItemSchema);
