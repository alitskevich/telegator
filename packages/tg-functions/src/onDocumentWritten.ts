import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { IngestItemSchema } from "tg-domain/ingest";
import { QUEUES } from "tg-enums/queueName";
import { drain } from "tg-firebase/ingest";
import { STAGE_OPTIONS, STAGES, settle } from "./stages";

/** Every Firestore trigger: the `ingest` queue and its operator controls. */

/**
 * Drains a stage as soon as one of its items is due: on enqueue and on replay.
 * Items due later (a delay, a retry's backoff) wait for `sweep`.
 */
export const ingest = onDocumentWritten({ ...STAGE_OPTIONS, document: "ingest/{id}" }, (event) => {
  const item = IngestItemSchema.safeParse(event.data?.after.data());
  if (!item.success || item.data.status !== "pending" || item.data.runAt > Date.now()) return;
  const stage = STAGES[item.data.stage];
  return settle(() => drain(item.data.stage, stage, stage.run));
});

/** Wakes a stage when an operator pauses, resumes, steps or runs it. */
export const ingestControl = onDocumentWritten(
  { ...STAGE_OPTIONS, document: "ingestControls/{stage}" },
  (event) => {
    const stage = QUEUES.find((queue) => queue === event.params.stage);
    if (stage === undefined) return;
    return settle(() => drain(stage, STAGES[stage], STAGES[stage].run));
  },
);
