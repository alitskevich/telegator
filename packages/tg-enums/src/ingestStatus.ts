import { z } from "zod";

/**
 * An `ingest` item's way through its stage: `pending` waits for its `runAt`,
 * `running` is held by a drain, `done` succeeded, `error` used up its attempts.
 */
export const INGEST_STATUSES = ["pending", "running", "done", "error"] as const;

export const IngestStatusSchema = z.enum(INGEST_STATUSES);
export type IngestStatus = z.infer<typeof IngestStatusSchema>;
