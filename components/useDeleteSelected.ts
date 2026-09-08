"use client";

import { useState } from "react";

/**
 * The in-flight state of §8.4 L810's delete, for the toolbar button that fires
 * it.
 *
 * One hook rather than one copy per table, for the reason `TableHead` is one
 * component: the button has to behave identically wherever an operator presses
 * it, and two copies drift.
 *
 * The promise was previously discarded — `void props.onDelete(...)` — and the
 * selection was cleared on the click rather than on the answer. A round trip
 * that rejected therefore looked exactly like one that succeeded: the boxes
 * emptied, the rows stayed, and nothing said why. Three things follow from
 * awaiting it instead.
 *
 * 1. The button reports that it is working, and refuses a second press. A
 *    repeated delete is harmless server-side — §8.4 L810's delete is soft and
 *    idempotent — but a button that swallows presses silently is what makes an
 *    operator press it again.
 * 2. The selection survives a failure, so the retry costs one press rather than
 *    re-ticking every box.
 * 3. The failure is on screen. `role="alert"` because it is the answer to
 *    something the operator just did and there is nothing else to notice it by.
 */
export interface DeleteSelection {
  readonly deleting: boolean;
  /** The last failure, or `""`. Cleared when the next delete starts. */
  readonly error: string;
  readonly run: (ids: readonly string[]) => void;
}

export function useDeleteSelected(
  onDelete: (ids: string[]) => Promise<void>,
  clearSelection: () => void,
): DeleteSelection {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const run = (ids: readonly string[]) => {
    // A delete of nothing would still revalidate the page and read as a
    // success; a second press mid-flight would send the same ids twice.
    if (deleting || ids.length === 0) return;

    setDeleting(true);
    setError("");

    onDelete([...ids])
      .then(() => {
        // The rows come back without the deleted ones (R16), so a selection
        // kept across that render would address ids the table no longer shows.
        clearSelection();
      })
      .catch((cause: unknown) => {
        // Next redacts a server action's message in production, so this is
        // often generic — but "something failed" is the fact that was missing.
        setError(cause instanceof Error ? cause.message : "Delete failed");
      })
      .finally(() => setDeleting(false));
  };

  return { deleting, error, run };
}
