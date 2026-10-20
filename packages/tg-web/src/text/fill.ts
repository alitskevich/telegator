/**
 * `"Scraped {processed} items"` + `{ processed: 4 }` → `"Scraped 4 items"`.
 *
 * The console's sentences live in `tg-rc/web.ts` with named holes, so a
 * template never builds text by concatenation. A hole with no value is left
 * visible rather than blanked: a toast reading `{queue}` is a bug someone will
 * report, and an empty gap is one nobody notices.
 */
export const fill = (template: string, values: Readonly<Record<string, unknown>>): string =>
  template.replace(/\{(\w+)\}/g, (hole, name: string) =>
    values[name] === undefined || values[name] === null ? hole : String(values[name]),
  );
