"use client";

/**
 * Hands the operator a file the server action just produced.
 *
 * §8.4 L816's export "returns CSV text"; `lib/dashboard/triggers.ts` says the
 * page turns it into a download, and no page did — every table discarded the
 * string, so the button read as broken and there was nothing to report about it.
 *
 * A `data:` URL rather than `URL.createObjectURL`: there is no object to revoke
 * afterwards, so a console left open all day cannot leak one per press.
 */
export function downloadText(filename: string, text: string, mediaType = "text/csv"): void {
  const anchor = document.createElement("a");
  anchor.href = `data:${mediaType};charset=utf-8,${encodeURIComponent(text)}`;
  anchor.download = filename;

  // Appended because Firefox ignores a click on an anchor outside the document.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** `sources-2026-09-09.csv` — the table, and the day it was taken. */
export const exportFilename = (table: string, now: Date): string =>
  `${table}-${now.toISOString().slice(0, "2026-09-09".length)}.csv`;
