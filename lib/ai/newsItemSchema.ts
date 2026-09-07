import { z } from "zod";
import { AiFieldsSchema, SUMMARY_MAX_LENGTH } from "../domain/item";
import { CategorySchema } from "./categories";

/**
 * The classification response schema, §5.2 L443–455.
 *
 * Derived from the payload's `AiFieldsSchema` rather than redeclaring nine
 * fields: that module already owns their types, L443's required/optional split
 * and §11.2's 220-character cap, and two hand-maintained definitions drift.
 *
 * Only `category` differs, and the difference is meaningful. §5.2 L451
 * constrains the model to §5.4's enum, while §2.2 L136 lets the item payload
 * carry an operator's arbitrary source default until AI overwrites it — so the
 * enum belongs here, at the model boundary, and nowhere else.
 *
 * The `.describe()` calls are not documentation. §5.2 L445–455's Description
 * column is the only place the "three words", "In Belarusian" and importance
 * guidance appear anywhere in the spec, and structured output drops them unless
 * they reach the emitted JSON Schema — at which point the model never receives
 * the instruction at all.
 */
export const NewsItemSchema = AiFieldsSchema.extend({
  title: AiFieldsSchema.shape.title.describe("Essential subject in three words, English."),
  /**
   * The character cap is stated in words, not left to `maxLength`.
   *
   * `AiFieldsSchema` already caps this at `SUMMARY_MAX_LENGTH`, and
   * `z.toJSONSchema` does emit `"maxLength": 220` — but a provider's structured
   * output enforces shape, types and enums, not string length. So the model was
   * held to a limit nobody had told it: it wrote what it thought fit, Zod
   * rejected anything over, and §3.2 L249 sent a *permanent* failure down the
   * transient-error path to the DLQ, where it burned every SQS retry first.
   *
   * Measured against three real DLQ bodies before and after: the longest (a
   * 3.3 KB essay) produced a 385-character summary with the limit unstated and
   * 203 with it stated. The other two passed either way and came back shorter.
   *
   * Interpolated rather than written as "220", so the cap has one definition —
   * the file header's own argument against two hand-maintained copies.
   */
  summary: AiFieldsSchema.shape.summary.describe(
    "Brief factual matter — no implications, opinions or judgements. In Belarusian. " +
      `At most ${SUMMARY_MAX_LENGTH} characters.`,
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
 * The JSON Schema sent as `output_config.format.schema` (§5.2 L425).
 *
 * Generated from the Zod schema, never hand-written — zod 4 emits it natively,
 * so there is one definition and the constraint the model is held to cannot
 * drift from the one this code validates against.
 */
export const NEWS_ITEM_SCHEMA = z.toJSONSchema(NewsItemSchema);
