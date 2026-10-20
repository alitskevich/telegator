import type { OverviewDeps } from "tg-actions/dashboard/overview";
import { loadOverview } from "tg-actions/dashboard/overview";
import { inspectDlq, loadQueues, purgeDlq, type QueuePageDeps } from "tg-actions/dashboard/queues";
import {
  deleteRecords,
  loadMembers,
  type RecordActionDeps,
  upsertRecord,
} from "tg-actions/dashboard/records";
import {
  consumeQueue,
  exportTable,
  publishPending,
  replayDlq,
  republishMessage,
  resetSourceCursors,
  runScraper,
  type TriggerDeps,
} from "tg-actions/dashboard/triggers";
import { type RequireRoleDeps, requireRole } from "tg-auth/session";
import { MessageStatusSchema } from "tg-enums/messageStatus";
import { z } from "zod";

/**
 * §8.4 — every operation the dashboard can ask for, by name.
 *
 * The browser holds no AWS credential, so this registry *is* the dashboard's
 * reach: an action missing here is one no operator can perform, and one added
 * here is one every signed-in browser can name. Each entry therefore starts
 * with a role check — the four reads below check `viewer` themselves, and the
 * rest delegate to `tg-actions/dashboard/`, whose cores check their own.
 * `tg-api/actions.test.ts` calls every entry anonymously to prove it.
 */

/** Every port an action may reach, without the caller. Built once per Lambda. */
export type ApiPorts = Omit<RecordActionDeps & TriggerDeps & QueuePageDeps & OverviewDeps, "auth">;

export type ActionDeps = ApiPorts & { readonly auth: RequireRoleDeps };

type Action = (input: unknown, deps: ActionDeps) => Promise<unknown>;

const ListMessagesInputSchema = z.object({ status: MessageStatusSchema });

export const ACTIONS = {
  /** Who the browser is signed in as, and what it may do — the client's only role source. */
  whoami: async (_input, deps) => {
    const session = await requireRole("viewer", deps.auth);
    return { sub: session.sub, email: session.email ?? null, roles: session.roles };
  },

  /** §8.3 — the Dashboard page. */
  overview: async (_input, deps) => {
    await requireRole("viewer", deps.auth);
    return loadOverview(deps);
  },

  /** §8.3 — the Sources table. */
  listSources: async (_input, deps) => {
    await requireRole("viewer", deps.auth);
    return deps.sources.listAll();
  },

  /** target-table#3.2 — the Targets table. */
  listTargets: async (_input, deps) => {
    await requireRole("viewer", deps.auth);
    return deps.targets.listAll();
  },

  /** §8.3 — one Messages tab. Parsed after the role check, as the cores do. */
  listMessages: async (input, deps) => {
    await requireRole("viewer", deps.auth);
    const { status } = ListMessagesInputSchema.parse(input);
    return deps.messages.queryByStatus(status);
  },

  /** §8.3 — the Pipeline page's depths. */
  loadQueues: async (_input, deps) => {
    await requireRole("viewer", deps.auth);
    return loadQueues(deps);
  },

  upsertRecord: (input, deps) => upsertRecord(input, deps),
  deleteRecords: (input, deps) => deleteRecords(input, deps),
  loadMembers: (input, deps) => loadMembers(input, deps),
  exportTable: (input, deps) => exportTable(input, deps),
  inspectDlq: (input, deps) => inspectDlq(input, deps),
  purgeDlq: (input, deps) => purgeDlq(input, deps),
  runScraper: (_input, deps) => runScraper(deps),
  resetSourceCursors: (_input, deps) => resetSourceCursors(deps),
  consumeQueue: (input, deps) => consumeQueue(input, deps),
  replayDlq: (input, deps) => replayDlq(input, deps),
  republishMessage: (input, deps) => republishMessage(input, deps),
  publishPending: (input, deps) => publishPending(input, deps),
} satisfies Record<string, Action>;

export type ActionName = keyof typeof ACTIONS;

export const ACTION_NAMES = Object.keys(ACTIONS) as [ActionName, ...ActionName[]];
