import { authContext, messages } from "../../actions/context";
import { loadMembers, upsertRecord as upsertRecordAction } from "../../actions/records";
import { exportTable, republishMessage } from "../../actions/triggers";
import { MessagesTable } from "../../components/MessagesTable";
import { hasRole } from "../../lib/auth/roles";
import { requireRole } from "../../lib/auth/session";
import { MessageStatusSchema } from "../../lib/domain/message";
import { authorized } from "../authorize";

/**
 * §8.3 L742 — the Messages page.
 *
 * §8.2 L722 spells the tab as `?status=`, so it is a URL and not component
 * state: a reload, a bookmark and a link shared with another operator all show
 * the same tab.
 */

export const dynamic = "force-dynamic";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await authorized(requireRole("viewer", await authContext()));
  const principal = { roles: session.roles, enabled: true };

  // §8.2 L722's example is `?status=topublish`, which is also the tab an
  // operator opens this page to work through. An unparseable value falls back
  // rather than 500s — a mistyped URL should not be an error page.
  const { status: raw } = await searchParams;
  const status = MessageStatusSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  const current = status.success ? status.data : "topublish";

  const rows = await messages.queryByStatus(current);

  async function save(id: string, delta: Record<string, string>) {
    "use server";
    await upsertRecordAction({ table: "messages", id, delta });
  }

  async function republish(messageId: string) {
    "use server";
    await republishMessage({ messageId });
  }

  async function members(messageId: string) {
    "use server";
    return loadMembers({ messageId });
  }

  async function exportMessages() {
    "use server";
    return exportTable({ table: "messages" });
  }

  return (
    <MessagesTable
      rows={rows}
      status={current}
      canEdit={hasRole(principal, "editor")}
      canAdmin={hasRole(principal, "admin")}
      onSave={save}
      onRepublish={republish}
      onLoadMembers={members}
      onExport={exportMessages}
    />
  );
}
