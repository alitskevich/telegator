import { authContext, sources } from "../../actions/context.js";
import {
  deleteRecords as deleteRecordsAction,
  upsertRecord as upsertRecordAction,
} from "../../actions/records.js";
import { exportTable, runScraper } from "../../actions/triggers.js";
import { SourcesTable } from "../../components/SourcesTable.js";
import { hasRole } from "../../lib/auth/roles.js";
import { requireRole } from "../../lib/auth/session.js";

/**
 * §8.3 L741 — the Sources page.
 *
 * Thin: authorise, load, render. Every action passed down re-checks the caller's
 * role server-side (§8.4 L757), so the `canEdit` and `canAdmin` flags below only
 * decide what is on screen — they are not the gate.
 */

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  // §8.6 L782 — `viewer` reads every page. An unauthorised caller gets the
  // AuthorizationError rather than a table with the controls hidden.
  const session = await requireRole("viewer", await authContext());
  const principal = { roles: session.roles, enabled: true };

  const rows = await sources.listAll();

  async function save(id: string, delta: Record<string, string>) {
    "use server";
    await upsertRecordAction({ table: "sources", id, delta });
  }

  async function remove(ids: string[]) {
    "use server";
    await deleteRecordsAction({ table: "sources", ids });
  }

  async function scrapeNow() {
    "use server";
    return runScraper();
  }

  async function exportSources() {
    "use server";
    return exportTable({ table: "sources" });
  }

  return (
    <SourcesTable
      rows={rows}
      canEdit={hasRole(principal, "editor")}
      canAdmin={hasRole(principal, "admin")}
      onSave={save}
      onDelete={remove}
      onScrapeNow={scrapeNow}
      onExport={exportSources}
    />
  );
}
