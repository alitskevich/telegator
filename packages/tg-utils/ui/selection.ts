/**
 * The select-all control the console's tables share.
 *
 * "All" is the rows on screen, and selecting **replaces** the selection rather
 * than adding to it: the button sits beside "Delete selected", and rows hidden by
 * a filter must not be carried into the delete.
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
