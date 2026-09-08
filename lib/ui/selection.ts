/**
 * The select-all control §8.3's tables share.
 *
 * *Reconciliation R57.* §8.3 L797-798 lists each table's toolbar — add, delete
 * selected, export, the triggers — and names no select-all, so an operator
 * addresses a set one checkbox at a time. That is the set the per-column filters
 * exist to produce, and a bulk delete of a narrowed table is the case they were
 * added for.
 *
 * "All" is the rows currently on screen, and selecting **replaces** the
 * selection rather than adding to it. The button sits beside "Delete selected":
 * a selection made before a filter narrowed the table would otherwise carry
 * rows the operator can no longer see into the delete.
 *
 * Shared by both tables rather than written per page, for the reason
 * `SOURCE_COLUMNS` and `cycleSort` are shared: two copies of one toolbar
 * behaviour drift.
 */

/**
 * Whether the rows on screen are all selected — the state that turns the button
 * from "select all" into "clear".
 *
 * An empty table is not "all selected". Nothing is on screen to act on, and
 * answering true there would offer a clear where an operator expects a select.
 */
export function allSelected(visibleIds: readonly string[], selected: ReadonlySet<string>): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
}

/** What one click on the button leaves selected. */
export function toggleSelectAll(
  visibleIds: readonly string[],
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  return allSelected(visibleIds, selected) ? new Set() : new Set(visibleIds);
}
