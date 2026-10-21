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
  { id: "pipeline", name: "Pipeline", icon: "workflow" },
  { id: "sources", name: "Sources", icon: "radio-tower" },
  { id: "targets", name: "Targets", icon: "send" },
  { id: "messages", name: "Messages", icon: "newspaper" },
  { id: "audit", name: "Audit", icon: "scroll-text" },
];

/** Column headings, by field. A field with no entry shows its own name. */
const labels: Record<string, string> = {
  id: "Id",
  status: "Status",
  target: "Target",
  category: "Category",
  teaser: "Teaser",
  via: "Via",
  lastCount: "Last count",
  lastResult: "Last result",
  zeroYieldRuns: "Empty runs",
  title: "Title",
  date: "Date",
  tgChannel: "Channel",
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
    title: "Sources",
    subtitle: "Telegram channels the scraper polls",
    noun: "source",
    empty: "No sources match",
    columns: columnsOf(SOURCE_COLUMNS),
  },
  targets: {
    title: "Targets",
    subtitle: "Where aggregated messages are published",
    noun: "target",
    empty: "No targets match",
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
  title: "Pipeline",
  subtitle: "Every stage, its queue and the items that failed. Select one to act on it.",
  inQueue: "in queue",
  replay: "Replay",
  replayMax: "Replay at most",
  cleanup: "Discard all",
  confirmCleanup: "Confirm: discard {count}",
  noErrors: "No errors",
  attempts: "{count} attempts",
  cause: "Cause",
  analyse: "Analyse",
  analyseAgain: "Analyse again",
  likelyCause: "Likely cause",
  proposedFix: "Proposed fix",
  scrapeNow: "Scrape now",
  emulate: "Emulate a post",
  resetIngest: "Reset ingest",
  confirmResetIngest: "Confirm: delete every item",
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
  selectHint: "Select a stage to see what it does and what you can do.",
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

/** The text fields of the scraped payload; `id`, `links` and `kind` show only in the JSON. */
const scrapedFields = [
  { id: "body", name: "Body", type: "textarea" },
  { id: "category", name: "Category", type: "text" },
  { id: "tags", name: "Tags", type: "text" },
  { id: "target", name: "Targets", type: "text" },
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

/**
 * The pipeline as the Pipeline page draws it (docs/telegator.md §1): the clock,
 * four stages, then Telegram; the Errors node stands apart. `metric` names an `Overview` field; `queue` names
 * the stage's lane in `ingest`.
 */
const stages = [
  {
    id: "schedule",
    kind: "trigger",
    icon: "timer",
    title: "Schedule",
    caption: "Cloud Scheduler, every 30 min",
    detail: "Starts a scrape on a clock. Deployed disabled; a deploy opts in.",
  },
  {
    id: "scrape",
    kind: "function",
    icon: "download",
    title: "Scrape",
    caption: "Polls each source",
    metric: "scraped",
    metricLabel: "scraped, 24 h",
    detail: "Reads new posts from every enabled source and queues each one for analysis.",
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
    caption: "Posts to every target",
    metric: "published",
    metricLabel: "published, all time",
    queue: "publish",
    detail:
      "Sends each settled story to its target channels and records every post. Runs 5 minutes after the last merge, one at a time.",
  },
  {
    id: "telegram",
    kind: "sink",
    icon: "message-circle",
    title: "Telegram",
    caption: "Target channels",
    detail: "Where the stories land. The Targets page lists them.",
  },
  {
    id: "errors",
    kind: "errors",
    icon: "triangle-alert",
    title: "Errors",
    caption: "Items that used up their attempts",
    metric: "errors",
    metricLabel: "across all stages",
    detail:
      "Every stage's failed items, with the error and its cause. Analyse asks the model for the likely cause and a fix; Run sends one item back to its stage.",
  },
] as const;

const records = {
  resetAll: "Reset all cursors",
  confirmReset: "Confirm: reset {count} sources",
  republish: "Re-publish",
};

const audit = {
  title: "Audit",
  subtitle: "Every send Telegram rejected, newest first. Kept for 30 days.",
  empty: "No rejected sends",
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
  common,
  auth,
  dashboard,
  pipeline,
  stages,
  payloadFields,
  records,
  audit,
  toasts,
};

export type Resources = typeof resources;
