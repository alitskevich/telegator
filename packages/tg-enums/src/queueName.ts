import { z } from "zod";

/** The three task stages; each drains its own items from `ingest`. */
export const QUEUES = ["analyze", "aggregate", "publish"] as const;

export const QueueNameSchema = z.enum(QUEUES);
export type QueueName = (typeof QUEUES)[number];
