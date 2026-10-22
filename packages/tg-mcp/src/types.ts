import type { MemberBlock } from "tg-domain/message";
import type { Messages, Sources, Targets } from "tg-firebase/db";
import type { z } from "zod";

export interface CreateMcpServerOptions {
  readonly version: string;
  readonly deps: McpDeps;
}

/** The repositories a tool may reach, and nothing else. */
export interface McpDeps {
  readonly sources: Sources;
  readonly targets: Targets;
  readonly messages: Messages;
}

/** One entry of the registry, transport-agnostic. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly run: (input: unknown, deps: McpDeps) => Promise<unknown>;
}

/** One member, flattened with its map key. */
export interface MemberEntry extends MemberBlock {
  readonly itemId: string;
}

/** What `find_messages_by_tags` returns per message. */
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
  readonly tags?: readonly string[];
  readonly image?: string;
  readonly memberCount: number;
  readonly members: MemberEntry[];
}
