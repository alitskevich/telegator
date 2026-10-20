/** The three Cloud Tasks queues, one per task-dispatched stage. */
export const QUEUES = ["analyze", "aggregate", "publish"] as const;

export type QueueName = (typeof QUEUES)[number];
