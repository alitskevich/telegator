import type { Message, MessageListItem } from "tg-domain/message";
import { SOURCE_STATUS_OK, SourceConfigInput, SourceSchema } from "tg-domain/source";
import { TagsSchema } from "tg-domain/tags";
import { TargetSchema } from "tg-domain/target";
import { TARGET_TYPES } from "tg-enums/targetType";
import { z } from "zod";
import { canonicalId } from "./ids";
import type { McpDeps, MessageContent, ToolDefinition } from "./types";

export const SEARCHED_STATUSES = ["published", "topublish"] as const;
export const MESSAGE_SCAN_LIMIT = 200;
export const MESSAGE_RESULT_LIMIT = 10;

/** The optional fields are exactly `SourceConfigInput`'s; a test pins this. */
export const AddSourceInput = z
  .object({
    id: z.string().min(1),
    ...SourceConfigInput.shape,
  })
  .strict();

export async function addSource(raw: unknown, deps: McpDeps) {
  const { id: rawId, ...config } = AddSourceInput.parse(raw);
  const id = canonicalId(rawId);

  const existing = await deps.sources.get(id);
  if (existing !== undefined) {
    throw new Error(`source already exists: ${id}`);
  }

  const row = SourceSchema.parse({
    ...config,
    id,
    status: config.status ?? SOURCE_STATUS_OK,
  });

  await deps.sources.put(row);
  return { created: row };
}

/** The optional fields are exactly `TARGET_WRITABLE_FIELDS`; a test pins this. */
export const AddTargetInput = z
  .object({
    id: z.string().min(1),
    type: z.enum(TARGET_TYPES).optional(),
    messageTemplate: z.string().optional(),
    tags: TagsSchema.optional(),
  })
  .strict();

export async function addTarget(raw: unknown, deps: McpDeps) {
  const { id: rawId, ...config } = AddTargetInput.parse(raw);
  const id = canonicalId(rawId);

  const existing = await deps.targets.get(id);
  if (existing !== undefined) {
    throw new Error(`target already exists: ${id}`);
  }

  const row = TargetSchema.parse({ ...config, id });
  await deps.targets.put(row);
  return { created: row };
}

export const FindMessagesInput = z
  .object({
    tags: z.array(z.string()).min(1),
    limit: z.number().int().min(1).max(MESSAGE_RESULT_LIMIT).default(MESSAGE_RESULT_LIMIT),
  })
  .strict();

function toMessageContent(message: Message): MessageContent {
  const members = Object.entries(message.members)
    .map(([itemId, block]) => ({ itemId, ...block }))
    .sort((a, b) => a.ts - b.ts);

  return {
    id: message.id,
    status: message.status,
    date: message.date,
    ts: message.ts,
    title: message.title,
    category: message.category,
    country: message.country,
    location: message.location,
    peoples: message.peoples,
    tags: message.tags,
    image: message.image,
    memberCount: message.memberCount,
    members,
  };
}

/** Scans recent messages by status and matches any tag as a whole, case-insensitive token. */
export async function findMessagesByTags(raw: unknown, deps: McpDeps) {
  const { tags, limit } = FindMessagesInput.parse(raw);

  const wanted = new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ""));
  if (wanted.size === 0) {
    throw new Error("tags must contain at least one non-blank tag");
  }

  const candidates: MessageListItem[] = [];
  for (const status of SEARCHED_STATUSES) {
    candidates.push(...(await deps.messages.queryByStatus(status, MESSAGE_SCAN_LIMIT)));
  }

  const matches = candidates.filter((candidate) =>
    (candidate.tags ?? []).some((tag) => wanted.has(tag.toLowerCase())),
  );

  matches.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : a.id.localeCompare(b.id)));

  const selected = matches.slice(0, limit);

  const messages: MessageContent[] = [];
  for (const candidate of selected) {
    const full = await deps.messages.get(candidate.id);
    if (full === undefined || full.deleted === true) continue;
    messages.push(toMessageContent(full));
  }

  return { matched: matches.length, returned: messages.length, messages };
}

/** The registry: exactly these three tools. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "add_source",
    description:
      "Create a new Telegator source (a Telegram channel to poll). Fails if the id already has a row, live or soft-deleted.",
    inputSchema: AddSourceInput,
    run: addSource,
  },
  {
    name: "add_target",
    description:
      "Create a new Telegator target (a publish destination). It receives every message carrying all of its tags, and nothing without tags. Fails if the id already has a row, live or soft-deleted.",
    inputSchema: AddTargetInput,
    run: addTarget,
  },
  {
    name: "find_messages_by_tags",
    description:
      `Find published or soon-to-publish messages carrying any of the given tags ` +
      `(case-insensitive), newest first. 'matched' counts matches inside the scanned ` +
      `window of up to ${MESSAGE_SCAN_LIMIT} recent messages per status, and may exceed 'returned'.`,
    inputSchema: FindMessagesInput,
    run: findMessagesByTags,
  },
];
