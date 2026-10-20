/**
 * Hands the operator a file the API just produced. §8.4's export answers CSV
 * text; this is what turns it into a download.
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
