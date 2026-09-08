import { authContext, targets } from "../../actions/context";
import {
  deleteRecords as deleteRecordsAction,
  upsertRecord as upsertRecordAction,
} from "../../actions/records";
import { exportTable } from "../../actions/triggers";
import { TargetsTable } from "../../components/TargetsTable";
import { hasRole } from "../../lib/auth/roles";
import { requireRole } from "../../lib/auth/session";
import { authorized } from "../authorize";

/**
 * target-table#3.2 — the Targets page.
 *
 * Thin: authorise, load, render. Every action passed down re-checks the
 * caller's role server-side (§8.4 L819), so `canEdit` only decides what is on
 * screen — it is not the gate.
 */

export const dynamic = "force-dynamic";

export default async function TargetsPage() {
  // §8.6 L842 — `viewer` reads every page.
  const session = await authorized(requireRole("viewer", await authContext()));
  const principal = { roles: session.roles, enabled: true };

  const rows = await targets.listAll();

  async function save(id: string, delta: Record<string, string>) {
    "use server";
    await upsertRecordAction({ table: "targets", id, delta });
  }

  async function remove(ids: string[]) {
    "use server";
    await deleteRecordsAction({ table: "targets", ids });
  }

  async function exportTargets() {
    "use server";
    return exportTable({ table: "targets" });
  }

  return (
    <TargetsTable
      rows={rows}
      canEdit={hasRole(principal, "editor")}
      onSave={save}
      onDelete={remove}
      onExport={exportTargets}
    />
  );
}
