import { QUEUES } from "tg-enums/queueName";
import {
  type DeadLetter,
  listDeadLetters,
  purgeDeadLetters,
  replayDeadLetters,
} from "tg-firebase/deadLetters";
import { z } from "zod";
import { type QueueStripEntry, queueStrip } from "./overview";

/** The Pipeline page: queue depths and the dead letters behind each stage. */

/** The most dead letters one inspection shows. */
export const DEAD_LETTER_PAGE = 50;

const QueueInput = z.object({ queueName: z.enum(QUEUES) });
const ReplayInput = QueueInput.extend({ max: z.number().int().positive() });

export const loadQueues = (): Promise<QueueStripEntry[]> => queueStrip();

export async function inspectDlq(input: unknown): Promise<DeadLetter[]> {
  return listDeadLetters(QueueInput.parse(input).queueName, DEAD_LETTER_PAGE);
}

export async function replayDlq(input: unknown): Promise<{ replayed: number }> {
  const { queueName, max } = ReplayInput.parse(input);
  return { replayed: await replayDeadLetters(queueName, max) };
}

export async function purgeDlq(input: unknown): Promise<{ discarded: number }> {
  return { discarded: await purgeDeadLetters(QueueInput.parse(input).queueName) };
}
