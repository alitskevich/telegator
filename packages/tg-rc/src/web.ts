import { SOURCE_TYPES, type SourceType } from "tg-enums/sourceType";
import { TARGET_TYPES } from "tg-enums/targetType";
import { MESSAGE_COLUMNS, SOURCE_COLUMNS, TARGET_COLUMNS } from "./columns";

/**
 * Everything the console's templates read as `R.…`: its words, its nav
 * and its column headings. Templates hold no text of their own, so a wording
 * change is one edit here.
 */

const app = { name: "Telegator", tagline: "Telegram news pipeline" };

/** The hash routes, in nav order. `page` is `@nav.page`. */
const nav = [
  { id: "dashboard", name: "Dashboard", icon: "layout-dashboard" },
  { id: "messages", name: "Messages", icon: "newspaper" },
  { id: "audit", name: "Audit", icon: "scroll-text" },
];

/** Column headings, by field. A field with no entry shows its own name. */
const labels: Record<string, string> = {
  id: "Id",
  status: "Status",
  tags: "Tags",
  category: "Category",
  teaser: "Teaser",
  lastCount: "Last count",
  lastResult: "Last result",
  zeroYieldRuns: "Empty runs",
  title: "Title",
  date: "Date",
  memberCount: "Members",
  type: "Type",
  lastPostedDate: "Last posted",
  lastPostedMessageId: "Last message",
  messageTemplate: "Template",
};

/** Right-aligned, tabular, and sorted as numbers. */
const NUMERIC = new Set(["lastCount", "zeroYieldRuns", "memberCount"]);

const columnsOf = (ids: readonly string[]) =>
  ids.map((id) => ({ id, name: labels[id] ?? id, numeric: NUMERIC.has(id) }));

const tables = {
  sources: {
    title: "All sources",
    subtitle: "Every reader's sources, in any status",
    noun: "source",
    empty: "No sources match",
    columns: columnsOf(SOURCE_COLUMNS),
  },
  // No page of its own: the Publish node lists the targets.
  targets: {
    noun: "target",
    columns: columnsOf(TARGET_COLUMNS),
  },
  messages: {
    title: "Messages",
    subtitle: "Aggregated stories, by publishing status",
    noun: "message",
    empty: "No messages match",
    columns: columnsOf(MESSAGE_COLUMNS),
  },
};

/** The Messages tabs, in the order an operator works through them. */
const messageTabs = [
  { id: "topublish", name: "To publish" },
  { id: "published", name: "Published" },
  { id: "error", name: "Failed" },
];

const common = {
  search: "Search visible columns",
  filter: "Filter",
  sortBy: "Sort by…",
  flipSort: "Reverse the order",
  refresh: "Refresh",
  export: "Export CSV",
  add: "Add",
  save: "Save",
  delete: "Delete selected",
  selectAll: "Select all",
  clearSelection: "Clear selection",
  loading: "Loading…",
  unavailable: "unavailable",
  members: "Members",
  noMembers: "No members recorded",
  newId: "New id",
  updated: "Updated",
  notFound: "Nothing at this address",
  backHome: "Back to the dashboard",
};

const auth = {
  signIn: "Sign in with Google",
  signOut: "Sign out",
  signInTitle: "Operator console",
  signInBody:
    "Sign in to watch the pipeline, edit sources and targets, and run its stages by hand.",
  deniedTitle: "No access yet",
  disabled: "This account is disabled. An administrator has to enable it before you can sign in.",
  forbidden: "This account has no role. An administrator has to grant it a role first.",
  checking: "Checking your access…",
  retry: "Try again",
};

const dashboard = {
  title: "Pipeline health",
  subtitle: "Every stage and its queue. Select one to act on it.",
  scraped: "Items scraped",
  analyzed: "Items analysed",
  skipped: "Items skipped",
  published: "Messages published",
  errors: "Errors",
  last24h: "last 24 h",
  allTime: "all time",
  allStages: "across all stages",
  status: "Status",
  categories: "Categories, 7 days",
  recent: "Recent messages",
  allMessages: "All messages",
  noData: "No data yet",
  noMessages: "No messages yet",
};

const pipeline = {
  inQueue: "in queue",
  cause: "Cause",
  scrapeNow: "Scrape now",
  emulate: "Emulate a post",
  resetIngest: "Reset ingest",
  confirmResetIngest: "Confirm: delete every item",
  resetCursors: "Reset all cursors",
  confirmResetCursors: "Confirm: reset every source",
  publishNow: "Publish now",
  publishMax: "Publish at most",
  runNow: "Run now",
  pause: "Pause",
  resume: "Resume",
  paused: "Paused",
  step: "Step",
  stepMax: "Run next",
  next: "Next in queue",
  emptyQueue: "Nothing waiting",
  run: "Run",
  due: "due {time}",
  headOfQueue: "next up",
  sources: "Sources, next run first",
  noSources: "No enabled sources",
  nextRun: "next run",
  afterNextRun: "due, after the next run",
  lastCount: "{count} last run",
  running: "running",
  failedTimes: "{count} failed",
  openMessages: "Open the publish backlog",
  item: {
    stage: "Stage",
    status: "Status",
    failed: "Failed",
    created: "Created",
    runAt: "Runs at",
    finished: "Finished",
    error: "Error",
    payload: "Payload as JSON",
  },
};

/** The Scrape node's tabs: `?tab=`, so a reload or a shared link shows the same one. */
const sourceTabs = [
  { id: "next", name: pipeline.sources },
  { id: "all", name: tables.sources.title },
];

/** The text fields of the scraped payload; `id`, `links` and `kind` show only in the JSON. */
const scrapedFields = [
  { id: "body", name: "Body", type: "textarea" },
  { id: "category", name: "Category", type: "text" },
  { id: "tags", name: labels.tags, type: "text" },
  { id: "image", name: "Image", type: "text" },
  { id: "date", name: "Date", type: "text" },
];

/** The `Forma` fields of each stage's payload in the item modal; publish carries only an id. */
const payloadFields = {
  analyze: scrapedFields,
  aggregate: [
    { id: "title", name: "Title", type: "text" },
    { id: "summary", name: "Summary", type: "textarea" },
    { id: "importance", name: "Importance", type: "text" },
    { id: "country", name: "Country", type: "text" },
    { id: "location", name: "Location", type: "text" },
    { id: "peoples", name: "People", type: "text" },
    { id: "properNames", name: "Proper names", type: "text" },
    ...scrapedFields,
  ],
  publish: [],
};

const sourceTypeNames: Record<SourceType, string> = {
  telegram: "Telegram, user account",
};

/** The option lists `Field.Enum` reads as `R.enums[typeSpec]`. */
const enums = {
  targetType: TARGET_TYPES.map((id) => ({ id, name: "Telegram channel" })),
  sourceType: SOURCE_TYPES.map((id) => ({ id, name: sourceTypeNames[id] })),
};

/** The Publish node's target channels: the `Table` columns and the edit modal's `Forma` fields. */
const telegram = {
  empty: "No target channels yet",
  // `Table` renders nothing with fewer than two columns.
  columns: [
    { id: "id", name: labels.id, width: "minmax(8rem, 1fr)" },
    { id: "type", name: labels.type, width: "minmax(8rem, 1fr)" },
    { id: "tags", name: labels.tags, width: "minmax(8rem, 1fr)" },
    { id: "lastPostedDate", name: labels.lastPostedDate, width: "minmax(8rem, 1fr)" },
    { id: "lastPostedMessageId", name: labels.lastPostedMessageId, width: "minmax(8rem, 1fr)" },
  ],
  // Every field; the ones publish owns are read-only.
  fields: [
    { id: "id", name: labels.id, type: "text", disabled: true },
    { id: "type", name: labels.type, type: "enum", typeSpec: "targetType" },
    {
      id: "tags",
      name: labels.tags,
      type: "text",
      placeholder: "Comma-separated. Empty: receives nothing",
    },
    { id: "lastPostedDate", name: labels.lastPostedDate, type: "text", disabled: true },
    { id: "lastPostedMessageId", name: labels.lastPostedMessageId, type: "text", disabled: true },
    {
      id: "messageTemplate",
      name: labels.messageTemplate,
      type: "textarea",
      placeholder: "Empty: the built-in layout",
    },
  ],
};

/** A source in the Dashboard page's edit modal: every field; the ones scrape owns are read-only. */
/** The Scrape node's All sources `Table`: the columns to scan by; the modal shows the rest. */
const sourceColumns = [
  { id: "id", name: labels.id, width: "minmax(10rem, 2fr)" },
  { id: "type", name: labels.type, width: "minmax(6rem, 1fr)" },
  { id: "status", name: labels.status, width: "minmax(5rem, 1fr)" },
  { id: "lastCount", name: labels.lastCount, width: "minmax(6rem, 1fr)" },
];

const sourceFields = [
  { id: "id", name: labels.id, type: "text", disabled: true },
  { id: "status", name: labels.status, type: "text", placeholder: "ok enables polling" },
  { id: "type", name: labels.type, type: "enum", typeSpec: "sourceType" },
  { id: "category", name: labels.category, type: "text" },
  { id: "tags", name: labels.tags, type: "text", placeholder: "Comma-separated" },
  { id: "teaser", name: labels.teaser, type: "text" },
  { id: "lastCount", name: labels.lastCount, type: "text", disabled: true },
  { id: "lastResult", name: labels.lastResult, type: "text", disabled: true },
  { id: "zeroYieldRuns", name: labels.zeroYieldRuns, type: "text", disabled: true },
];

/**
 * The pipeline as the Dashboard page draws it (docs/telegator.md §1): scrape, then
 * three stages; failed items live on the Audit page. `metric`
 * names an `Overview` field; `queue` names the stage's lane in `ingest`; `sources` names the sources its panel lists.
 */
const stages = [
  {
    id: "scrape",
    kind: "function",
    icon: "download",
    title: "Scrape",
    caption: "Via a user account",
    metric: "scraped",
    metricLabel: "scraped, 24 h",
    detail:
      "Reads new posts from the Telegram sources (channels, groups and chats) through a logged-in Telegram account, and queues each one for analysis.",
    sources: "telegram",
  },
  {
    id: "analyze",
    kind: "function",
    icon: "brain",
    title: "Analyze",
    caption: "Classifies each item",
    metric: "analyzed",
    metricLabel: "analysed, 24 h",
    queue: "analyze",
    detail:
      "Asks the model for a category and a summary, and skips what is not news. Runs 5 at a time.",
  },
  {
    id: "aggregate",
    kind: "function",
    icon: "git-merge",
    title: "Aggregate",
    caption: "Merges duplicates",
    queue: "aggregate",
    detail:
      "Matches each item against the day's stories and merges it, or starts a new one. Runs one at a time.",
  },
  {
    id: "publish",
    kind: "function",
    icon: "send",
    title: "Publish",
    caption: "Posts to every Telegram target",
    metric: "published",
    metricLabel: "published, all time",
    queue: "publish",
    detail:
      "Sends each settled story to every channel whose tags it carries, and records every post. Runs 5 minutes after the last merge, one at a time. Add a channel below, or select one to edit its tags or template.",
  },
] as const;

const records = {
  republish: "Re-publish",
  delete: "Delete",
};

const audit = {
  title: "Audit",
  subtitle: "The items that used up their attempts, and the record of what went wrong.",
  failed: "Failed items",
  failedHint:
    "Every stage's failed items, oldest first, with the error and its cause. Analyse asks the model for the likely cause and a fix; Run sends one item back to its stage.",
  noErrors: "No errors",
  attempts: "{count} attempts",
  analyse: "Analyse",
  analyseAgain: "Analyse again",
  likelyCause: "Likely cause",
  proposedFix: "Proposed fix",
  replay: "Replay",
  replayMax: "Replay at most",
  cleanup: "Discard all",
  confirmCleanup: "Confirm: discard {count}",
  history: "History",
  historyHint: "Every rejected send and every failed item, newest first. Kept for 30 days.",
  empty: "Nothing went wrong in the last 30 days",
  rejected: "Rejected sends",
  open: "Rejected sends not yet followed by a successful post",
};

/** Success toasts, by action; `{name}` is filled from the action's result. */
const toasts = {
  added: "Added {id}",
  saved: "Saved {id}",
  deleted: "Deleted {count} {noun}(s)",
  exported: "Exported {file}",
  runScraper: "Scraped {processed} items",
  emulateItem: "Queued fake post {id}",
  resetIngest: "Deleted {deleted} ingest items",
  resetSourceCursors:
    "Reset {reset} sources; the next scrape starts from each channel's latest post",
  retryErrors: "Replayed {replayed} errors",
  purgeErrors: "Discarded {discarded} errors",
  diagnoseError: "Analysed {ref}",
  runStage: "Released {released} in {queue}",
  pauseStage: "Paused {queue}",
  resumeStage: "Resumed {queue}",
  runItem: "Running {ref} next",
  runItemGone: "{ref} is no longer waiting",
  republishMessage: "Queued {id} for re-publishing",
  publishPending: "Queued {published} for publishing",
  failed: "Request failed",
};

export const resources = {
  app,
  nav,
  tables,
  messageTabs,
  sourceTabs,
  common,
  auth,
  dashboard,
  pipeline,
  stages,
  payloadFields,
  enums,
  telegram,
  sourceColumns,
  sourceFields,
  records,
  audit,
  toasts,
};

export type Resources = typeof resources;
