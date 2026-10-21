/** The three task stages; each drains its own items from `ingest`. */
export const QUEUES = ["analyze", "aggregate", "publish"] as const;

export type QueueName = (typeof QUEUES)[number];
