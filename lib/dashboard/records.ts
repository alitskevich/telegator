import { z } from "zod";
import { type RequireRoleDeps, requireRole } from "../auth/session.js";
import type { MessageRepo, SourceRepo } from "../db/ports.js";
import { SourceSchema } from "../domain/source.js";

/**
 * §8.4 L749-751 — `upsertRecord` and `deleteRecords`, both `editor`.
 *
 * The logic lives here rather than in `actions/records.ts` so it can be tested
 * without a request context; the action file is a `"use server"` wrapper, the
 * same shape as the Lambda entry points over `lib/pipeline/`.
 */

export const TABLES = ["sources", "messages"] as const;
export type TableName = (typeof TABLES)[number];

/**
 * §2.1 L102-106's "Written by: operator" column, exactly.
 *
 * Everything omitted is written by the scrape stage, and `lastItemId` is the
 * reason the omission is enforced rather than trusted: §2.1 L107 calls it "the
 * sole duplicate-suppression mechanism", so an operator editing it silently
 * re-scrapes or skips a range of history with no error anywhere.
 */
export const SOURCE_WRITABLE_FIELDS = [
  "status",
  "tgChannel",
  "category",
  "tags",
  "teaser",
] as const;

/**
 * §8.3 L742's descriptive columns — R37.
 *
 * The Messages table also shows `id`, `status`, `date` and `memberCount`, and
 * none of them is editable. `id` is the key. `memberCount` is `size(members)` by
 * §2.3 L145's invariant, so editing it produces a record `MessageSchema` itself
 * rejects. `date` partitions `date-index`, which §6's dedup reads. And `status`
 * is a pipeline state machine whose only correct transition is §8.4 L753's
 * `republishMessage`, because that also enqueues — setting `topublish` here
 * would leave a message waiting for a publish that nothing asked for.
 */
export const MESSAGE_WRITABLE_FIELDS = ["title", "category", "tgChannel"] as const;

/** Every operator-writable field is a string, so one shape covers both tables. */
const writableDelta = <T extends readonly [string, ...string[]]>(fields: T) =>
  z
    .object(
      Object.fromEntries(fields.map((field) => [field, z.string()])) as Record<string, z.ZodString>,
    )
    .partial()
    .strict()
    // An empty delta is a write of nothing that would still revalidate the page
    // and read as a successful save.
    .refine((delta) => Object.keys(delta).length > 0, {
      message: "delta must change at least one field",
    });

const UpsertInputSchema = z.discriminatedUnion("table", [
  z.object({
    table: z.literal("sources"),
    id: z.string().min(1),
    delta: writableDelta(SOURCE_WRITABLE_FIELDS),
  }),
  z.object({
    table: z.literal("messages"),
    id: z.string().min(1),
    delta: writableDelta(MESSAGE_WRITABLE_FIELDS),
  }),
]);

const DeleteInputSchema = z.object({
  table: z.enum(TABLES),
  // A delete of nothing is a mistake worth surfacing, not a no-op to absorb.
  ids: z.array(z.string().min(1)).min(1),
});

export interface RecordActionDeps {
  readonly sources: SourceRepo;
  readonly messages: MessageRepo;
  readonly auth: RequireRoleDeps;
  /** `revalidatePath` in production; injected so this module never imports Next. */
  readonly revalidate: (path: string) => void;
}

const repoFor = (table: TableName, deps: RecordActionDeps) =>
  table === "sources" ? deps.sources : deps.messages;

/** §8.2's route tree — the page whose data this write invalidates. */
const pathFor = (table: TableName) => `/${table}`;

export async function upsertRecord(input: unknown, deps: RecordActionDeps): Promise<void> {
  // Authorisation first, and before parsing: a viewer must not learn which
  // fields are writable by probing this action's validation messages.
  await requireRole("editor", deps.auth);

  const { table, id, delta } = UpsertInputSchema.parse(input);

  if (table === "messages") {
    /**
     * A message id is `{sourceId}/{telegramMessageId}`, minted by the scrape
     * stage from a real Telegram post. Nothing an operator could type
     * corresponds to one, so a create here could only produce a record §6's
     * dedup would never match. Checked explicitly rather than left to
     * `UpdateItem`, which creates the row it cannot find.
     */
    const existing = await deps.messages.get(id);
    if (existing === undefined) throw new Error(`no such message: ${id}`);

    await deps.messages.patch(id, delta);
    deps.revalidate(pathFor(table));
    return;
  }

  const existing = await deps.sources.get(id);

  if (existing === undefined) {
    /**
     * §8.3 L741's "add". A bare `UpdateItem` would create a *partial* source —
     * no `lastCount`, no `zeroYieldRuns` — and §3.1's refresh heuristic and
     * §4.1's staleness alarm both read those, so the source would poll on the
     * wrong schedule and never alarm. `SourceSchema` supplies the defaults.
     */
    await deps.sources.put(SourceSchema.parse({ id, ...delta }));
  } else {
    await deps.sources.patch(id, delta);
  }

  deps.revalidate(pathFor(table));
}

export async function deleteRecords(input: unknown, deps: RecordActionDeps): Promise<void> {
  await requireRole("editor", deps.auth);

  const { table, ids } = DeleteInputSchema.parse(input);

  await repoFor(table, deps).softDelete(ids);
  deps.revalidate(pathFor(table));
}
