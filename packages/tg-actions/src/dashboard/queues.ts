import { QUEUES } from "tg-enums/queueName";
import { listDeadLetters, purgeDeadLetters, replayDeadLetters } from "tg-firebase/deadLetters";
import type { StoredIngestItem } from "tg-firebase/types";
import { z } from "zod";

/** The Pipeline page: the dead letters behind each task-dispatched stage. */

/** The most dead letters one inspection shows. */
export const DEAD_LETTER_PAGE = 50;

const QueueInput = z.object({ queueName: z.enum(QUEUES) });
const ReplayInput = QueueInput.extend({ max: z.number().int().positive() });

export async function inspectDlq(input: unknown): Promise<StoredIngestItem[]> {
  return listDeadLetters(QueueInput.parse(input).queueName, DEAD_LETTER_PAGE);
}

export async function replayDlq(input: unknown): Promise<{ replayed: number }> {
  const { queueName, max } = ReplayInput.parse(input);
  return { replayed: await replayDeadLetters(queueName, max) };
}

export async function purgeDlq(input: unknown): Promise<{ discarded: number }> {
  return { discarded: await purgeDeadLetters(QueueInput.parse(input).queueName) };
}
