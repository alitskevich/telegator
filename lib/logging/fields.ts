/**
 * Log field and message names that something other than the emitting stage reads.
 *
 * `lib/aws/observability.ts` builds §8.5 L771's Logs Insights query from these,
 * so the query cannot drift from what the analyze stage writes. They live here
 * rather than in `lib/pipeline/analyze/index.ts` because §8.2 L734 forbids the
 * dashboard from reaching a pipeline stage at all — and importing a stage for
 * two string constants would put it in the Amplify bundle, which is exactly the
 * dependency the section exists to prevent.
 */

/** The `msg` of the line the category chart counts. */
export const CLASSIFIED_LOG_MESSAGE = "item classified";

/** The field that line carries the model's category in. */
export const CATEGORY_LOG_FIELD = "category";
