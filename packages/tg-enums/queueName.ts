/**
 * §7.3 L654 — "each has a matching DLQ". The three queues an operator may drain.
 *
 * Defined here rather than in `tg-pipeline/handlers/dlqReplay.ts` so the dashboard can name
 * them without importing a module that imports `tg-pipeline/`, which §8.2 L792
 * forbids it from depending on.
 */
export const REPLAYABLE_QUEUES = ["analyze", "aggregate", "publish"] as const;

export type ReplayableQueue = (typeof REPLAYABLE_QUEUES)[number];
