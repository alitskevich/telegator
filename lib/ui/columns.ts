/**
 * §8.3 L741 and L742's table columns.
 *
 * One definition per table, shared by the page and by §8.4 L755's export — L744
 * ties them together ("filters across visible columns"), and an export whose
 * columns differed from the table it was taken from would be quietly wrong.
 */

/** §8.3 L741 — the Sources table. */
export const SOURCE_COLUMNS = [
  "id",
  "status",
  "tgChannel",
  "category",
  "teaser",
  "lastCount",
  "lastResult",
  "zeroYieldRuns",
] as const;

/** §8.3 L742 — the Messages table, minus the expandable member list. */
export const MESSAGE_COLUMNS = [
  "id",
  "title",
  "category",
  "status",
  "date",
  "tgChannel",
  "memberCount",
] as const;
