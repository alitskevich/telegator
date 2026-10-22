/**
 * The console's table columns. One definition per table, shared by the page and
 * the CSV export, so an export always matches the table it was taken from.
 */

/** The Sources table; `type` shows the reader. */
export const SOURCE_COLUMNS = [
  "id",
  "status",
  "tags",
  "category",
  "teaser",
  "type",
  "lastCount",
  "lastResult",
  "zeroYieldRuns",
] as const;

/** The Messages table, minus the expandable member list. */
export const MESSAGE_COLUMNS = [
  "id",
  "title",
  "category",
  "status",
  "date",
  "tags",
  "memberCount",
] as const;

/** The targets export. `messageTemplate` is last because it is by far the widest. */
export const TARGET_COLUMNS = [
  "id",
  "type",
  "tags",
  "lastPostedDate",
  "lastPostedMessageId",
  "messageTemplate",
] as const;

/** The collections the console edits. */
export const TABLES = ["sources", "messages", "targets"] as const;
export type TableName = (typeof TABLES)[number];

/** The fields an operator may edit, per collection. Everything else is the pipeline's. */
export const SOURCE_WRITABLE_FIELDS = ["status", "category", "tags", "teaser", "type"] as const;
export const MESSAGE_WRITABLE_FIELDS = ["title", "category"] as const;
export const TARGET_WRITABLE_FIELDS = ["type", "messageTemplate", "tags"] as const;
