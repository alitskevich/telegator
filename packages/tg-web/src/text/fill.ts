/**
 * `"Scraped {processed} items"` + `{ processed: 4 }` → `"Scraped 4 items"`.
 * A hole with no value stays visible, so the bug gets noticed.
 */
export const fill = (template: string, values: Readonly<Record<string, unknown>>): string =>
  template.replace(/\{(\w+)\}/g, (hole, name: string) =>
    values[name] === undefined || values[name] === null ? hole : String(values[name]),
  );
