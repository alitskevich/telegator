"use client";

import { useAction } from "./useAction";

/**
 * §8.4 L814's delete, for the toolbar button that fires it.
 *
 * One hook rather than one copy per table, for the reason `TableHead` is one
 * component: the button has to behave identically wherever an operator presses
 * it, and two copies drift. It is now `useAction` plus the two things that are
 * particular to a bulk delete.
 *
 * 1. The **selection is cleared on the answer, not on the click**. It used to be
 *    cleared on the click, so a round trip that rejected looked exactly like one
 *    that succeeded: the boxes emptied, the rows stayed, and nothing said why.
 *    Cleared on success only, a failed delete costs one press to retry rather
 *    than re-ticking every box.
 * 2. A delete of **nothing** is refused. It would revalidate the page and read
 *    as a success.
 */
export interface DeleteSelection {
  readonly deleting: boolean;
  readonly run: (ids: readonly string[]) => void;
}

export function useDeleteSelected(
  onDelete: (ids: string[]) => Promise<void>,
  /** What the rows are, for the toast: "Deleted 3 sources". */
  noun: string,
  clearSelection: () => void,
): DeleteSelection {
  const action = useAction(onDelete, {
    // The rows come back without the deleted ones (R16), so a selection kept
    // across that render would address ids the table no longer shows.
    onDone: clearSelection,
    describe: (_result, ids) => `Deleted ${ids.length} ${noun}${ids.length === 1 ? "" : "s"}`,
    failure: "Delete failed",
  });

  return {
    deleting: action.running,
    run: (ids: readonly string[]) => {
      if (ids.length === 0) return;
      action.run([...ids]);
    },
  };
}
