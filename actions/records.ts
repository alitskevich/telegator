"use server";

import { revalidatePath } from "next/cache";
import {
  deleteRecords as deleteRecordsCore,
  loadMembers as loadMembersCore,
  type MemberRow,
  type RecordActionDeps,
  upsertRecord as upsertRecordCore,
} from "../lib/dashboard/records.js";
import { authContext, messages, sources } from "./context.js";

/**
 * §8.4 L749-751. Thin wrappers: every rule — the `editor` check, the writable
 * -field allowlist, the soft delete — lives in `lib/dashboard/records.ts`, which
 * is where the tests are.
 */

async function deps(): Promise<RecordActionDeps> {
  return { sources, messages, auth: await authContext(), revalidate: revalidatePath };
}

export async function upsertRecord(input: unknown): Promise<void> {
  await upsertRecordCore(input, await deps());
}

export async function deleteRecords(input: unknown): Promise<void> {
  await deleteRecordsCore(input, await deps());
}

/** R26 — the lazy base-table read behind §8.3 L742's expandable member list. */
export async function loadMembers(input: unknown): Promise<MemberRow[]> {
  return loadMembersCore(input, await deps());
}
