import { loadOverview } from "tg-actions/dashboard/overview";
import { inspectDlq, purgeDlq, replayDlq } from "tg-actions/dashboard/queues";
import { deleteRecords, loadMembers, upsertRecord } from "tg-actions/dashboard/records";
import {
  exportTable,
  publishPending,
  republishMessage,
  resetSourceCursors,
  runScraper,
} from "tg-actions/dashboard/triggers";
import { MessageStatusSchema } from "tg-enums/messageStatus";
import type { Role } from "tg-enums/roles";
import { messages, sources, targets } from "tg-firebase/db";
import type { Operator } from "tg-firebase/operators";
import { z } from "zod";

type Action = (input: unknown, operator: Operator) => Promise<unknown>;

/**
 * Every console action, with the least role that may call it. The dispatcher
 * checks the role before the action runs, so no action can forget to.
 */
export const ACTIONS: Record<string, readonly [Role, Action]> = {
  whoami: ["viewer", async (_, { email, roles }) => ({ email: email ?? null, roles })],
  overview: ["viewer", () => loadOverview()],
  listSources: ["viewer", () => sources.listAll()],
  listTargets: ["viewer", () => targets.listAll()],
  listMessages: [
    "viewer",
    (input) =>
      messages.queryByStatus(z.object({ status: MessageStatusSchema }).parse(input).status),
  ],
  loadMembers: ["viewer", loadMembers],
  inspectDlq: ["viewer", inspectDlq],
  exportTable: ["viewer", exportTable],
  upsertRecord: ["editor", upsertRecord],
  deleteRecords: ["editor", deleteRecords],
  runScraper: ["admin", () => runScraper()],
  resetSourceCursors: ["admin", () => resetSourceCursors()],
  republishMessage: ["admin", republishMessage],
  publishPending: ["admin", publishPending],
  replayDlq: ["admin", replayDlq],
  purgeDlq: ["admin", purgeDlq],
};
