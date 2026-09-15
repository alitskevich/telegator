import { PurgeQueueCommand, type PurgeQueueCommandOutput } from "@aws-sdk/client-sqs";

/**
 * R57 — "Cleanup all": discard everything sitting in one DLQ.
 *
 * The counterpart to §3.5's replay. Replay is the recovery path; this is the
 * other half of the same decision, for the backlog an operator has inspected and
 * judged unrecoverable — a poison payload, or a batch already superseded by a
 * later scrape. Without it a DLQ that will never drain cleanly keeps §7.7's
 * depth alarm lit for good, and an operator learns to ignore it.
 *
 * It is irreversible in a way replay is not: §1.3 L69 says a dead-lettered post
 * "leaves no row anywhere", so the DLQ is its last copy and a purge is the end
 * of it. The panel therefore asks twice, and §8.4's `admin` gate applies.
 */

/**
 * SQS allows one `PurgeQueue` per queue per 60 seconds and takes up to the same
 * 60 seconds to finish. Both facts are AWS's, not a tuning choice: the first is
 * why a second press is refused, the second is why the depth an operator sees
 * afterwards may not be zero yet.
 */
export const PURGE_COOLDOWN_SECONDS = 60;

export interface DlqPurger {
  purge(queueUrl: string): Promise<void>;
}

/** The slice of `SQSClient` used here; injected so tests build none. */
export interface SqsPurgeClient {
  send(command: PurgeQueueCommand): Promise<PurgeQueueCommandOutput>;
}

export function createSqsDlqPurger(client: SqsPurgeClient): DlqPurger {
  return {
    async purge(queueUrl) {
      try {
        await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
      } catch (error) {
        /**
         * Matched on `name` rather than `instanceof PurgeQueueInProgress`: the
         * cooldown is the one failure an operator meets in normal use — press
         * twice, or press after a colleague did — and it deserves a sentence
         * saying to wait, not an SDK error naming a queue url.
         */
        if (error instanceof Error && error.name === "PurgeQueueInProgress") {
          throw new Error(
            `a purge of this DLQ is already in progress; SQS allows one every ${PURGE_COOLDOWN_SECONDS} seconds`,
          );
        }
        throw error;
      }
    },
  };
}
