import { CategorySchema } from "tg-enums/categories";
import { z } from "zod";
import { AiFieldsSchema, SUMMARY_MAX_LENGTH } from "./item";

/**
 * The classification response schema, derived from `AiFieldsSchema` so the
 * fields are defined once. Only `category` differs: the model is held to the
 * enum, while the item may carry an operator's arbitrary default.
 *
 * The `.describe()` calls are instructions, not documentation: they reach the
 * model only through the emitted JSON Schema.
 */
export const NewsItemSchema = AiFieldsSchema.extend({
  title: AiFieldsSchema.shape.title.describe("Essential subject in three words, English."),
  /**
   * The cap is stated in words: structured output does not enforce `maxLength`,
   * so an untold model wrote longer summaries, which failed validation and were
   * retried into an `error` item.
   */
  summary: AiFieldsSchema.shape.summary.describe(
    "Brief factual matter — no implications, opinions or judgements. In Belarusian. " +
      `At most ${SUMMARY_MAX_LENGTH} characters.`,
  ),
  country: AiFieldsSchema.shape.country.describe("ISO-3166 alpha-2 code."),
  location: AiFieldsSchema.shape.location.describe("City or region, English."),
  category: CategorySchema.describe("One of the listed categories."),
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
 * The JSON Schema sent as `output_config.format.schema`. Generated from the Zod
 * schema, so what the model is held to cannot drift from what is validated.
 */
export const NEWS_ITEM_SCHEMA = z.toJSONSchema(NewsItemSchema);
