import { listMessages, loadAudit } from "tg-actions/dashboard/audit";
import { emulateItem } from "tg-actions/dashboard/emulate";
import { loadOverview } from "tg-actions/dashboard/overview";
import {
  diagnoseError,
  editItem,
  inspectErrors,
  inspectItem,
  inspectQueue,
  inspectSources,
  pauseStage,
  purgeErrors,
  resetIngest,
  retryErrors,
  runItem,
  runStage,
} from "tg-actions/dashboard/queues";
import { deleteRecords, loadMembers, upsertRecord } from "tg-actions/dashboard/records";
import {
  exportTable,
  publishPending,
  republishMessage,
  resetSourceCursors,
  runScraper,
} from "tg-actions/dashboard/triggers";
import { createOpenRouterDiagnoser } from "tg-ai/diagnoser";
import type { Role } from "tg-enums/roles";
import { sources, targets } from "tg-firebase/db";
import type { Operator } from "tg-firebase/operators";
import { mtprotoSession, openRouterKey } from "./secrets";

type Action = (input: unknown, operator: Operator) => Promise<unknown>;

const diagnoser = createOpenRouterDiagnoser({ apiKey: async () => openRouterKey.value() });

/**
 * Every console action, with the least role that may call it. The dispatcher
 * checks the role before the action runs, so no action can forget to.
 */
export const ACTIONS: Record<string, readonly [Role, Action]> = {
  whoami: ["viewer", async (_, { email, roles }) => ({ email: email ?? null, roles })],
  overview: ["viewer", () => loadOverview()],
  listSources: ["viewer", () => sources.listAll()],
  listTargets: ["viewer", () => targets.listAll()],
  listMessages: ["viewer", listMessages],
  loadMembers: ["viewer", loadMembers],
  loadAudit: ["viewer", loadAudit],
  inspectErrors: ["viewer", () => inspectErrors()],
  inspectQueue: ["viewer", inspectQueue],
  inspectItem: ["viewer", inspectItem],
  inspectSources: ["viewer", () => inspectSources()],
  exportTable: ["viewer", exportTable],
  upsertRecord: ["editor", upsertRecord],
  deleteRecords: ["editor", deleteRecords],
  runScraper: ["admin", () => runScraper(mtprotoSession.value())],
  emulateItem: ["admin", () => emulateItem()],
  resetIngest: ["admin", () => resetIngest()],
  resetSourceCursors: ["admin", () => resetSourceCursors()],
  republishMessage: ["admin", republishMessage],
  publishPending: ["admin", publishPending],
  retryErrors: ["admin", retryErrors],
  purgeErrors: ["admin", () => purgeErrors()],
  diagnoseError: ["admin", (input) => diagnoseError(input, diagnoser)],
  runStage: ["admin", runStage],
  runItem: ["admin", runItem],
  editItem: ["admin", editItem],
  pauseStage: ["admin", pauseStage],
};
