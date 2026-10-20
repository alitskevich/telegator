/**
 * multi-target#3.7, #8.2 — what the migration writes for one live source row,
 * or nothing.
 *
 * Pure, over the raw row: the script scans with the document client rather
 * than `SourceRepo.listAll`, because `SourceSchema` strips `tgChannel` — the
 * very attribute this is looking for. The patch never removes `tgChannel`
 * (D8): the old code reads it until the new one is deployed.
 */
export function legacyTargetPatch(raw: unknown): { readonly target: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;

  const { tgChannel, target } = raw as { tgChannel?: unknown; target?: unknown };

  // Plan ruling P5 — a cleared `target` still published from `tgChannel` under
  // the old code, so it is copied like an absent one.
  if (typeof target === "string" && target !== "") return undefined;
  if (typeof tgChannel !== "string" || tgChannel === "") return undefined;

  return { target: tgChannel };
}
