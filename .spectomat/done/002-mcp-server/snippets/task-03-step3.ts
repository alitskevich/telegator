import { z } from "zod";
import type { MessageRepo, SourceRepo, TargetRepo } from "../db/ports";
import type { MemberBlock, Message, MessageListItem } from "../domain/message";
import { SOURCE_STATUS_OK, SourceConfigInput, SourceSchema } from "../domain/source";
import { splitTags } from "../domain/tags";
import { TARGET_TYPES, TargetSchema } from "../domain/target";
import { canonicalId } from "./ids";

/**
 * mcp-server#5 — constants declared once, reused nowhere else in this
 * subsystem's algorithms.
 */
export const SEARCHED_STATUSES = ["published", "topublish"] as const;
export const MESSAGE_SCAN_LIMIT = 200;
export const MESSAGE_RESULT_LIMIT = 10;

/** mcp-server#2.2 — the ports a tool may reach, and nothing else. */
export interface McpDeps {
  readonly sources: SourceRepo;
  readonly targets: TargetRepo;
  readonly messages: MessageRepo;
}

/** mcp-server#2.1 — one entry of the registry, transport-agnostic. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly run: (input: unknown, deps: McpDeps) => Promise<unknown>;
}

/**
 * mcp-server#2, #3.2, D16 — the optional fields are exactly `SourceConfigInput`'s
 * (`lib/domain/source.ts`), which mcp-server#15.3 pins with a test.
 */
export const AddSourceInput = z
  .object({
    id: z.string().min(1),
    ...SourceConfigInput.shape,
  })
  .strict();

/** mcp-server#5.1 */
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

/**
 * mcp-server#2, #3.3, D16 — the optional fields are exactly `TARGET_WRITABLE_FIELDS`
 * (`lib/dashboard/records.ts`), which mcp-server#15.3 pins with a test.
 */
export const AddTargetInput = z
  .object({
    id: z.string().min(1),
    type: z.enum(TARGET_TYPES).optional(),
    messageTemplate: z.string().optional(),
  })
  .strict();

/** mcp-server#5.2 */
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

/** mcp-server#2.3 — one member, flattened with its map key. */
export interface MemberEntry extends MemberBlock {
  readonly itemId: string;
}

/** mcp-server#2.3 — what `find_messages_by_tags` returns per message. */
export interface MessageContent {
  readonly id: string;
  readonly status: string;
  readonly date: string;
  readonly ts: number;
  readonly title?: string;
  readonly category?: string;
  readonly country?: string;
  readonly location?: string;
  readonly peoples?: string;
  readonly tags?: string;
  readonly image?: string;
  readonly tgChannel?: string;
  readonly memberCount: number;
  readonly members: MemberEntry[];
}

export const FindMessagesInput = z
  .object({
    tags: z.array(z.string()).min(1),
    limit: z.number().int().min(1).max(MESSAGE_RESULT_LIMIT).default(MESSAGE_RESULT_LIMIT),
  })
  .strict();

/** mcp-server#5.3 */
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
    tgChannel: message.tgChannel,
    memberCount: message.memberCount,
    members,
  };
}

/** mcp-server#5.3 */
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
    splitTags(candidate.tags).some((tag) => wanted.has(tag.toLowerCase())),
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

/** mcp-server#2.1, #6.1 — the registry: exactly these three tools, and no others. */
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
      "Create a new Telegator target (a publish destination). Fails if the id already has a row, live or soft-deleted.",
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
