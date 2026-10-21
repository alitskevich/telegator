import { z } from "zod";

/** The slices of the Gmail API v1 `users.messages` responses the reader uses. */

/** One MIME part. `body.data` is base64url; a multipart carries `parts` instead. */
export const MessagePartSchema = z.object({
  mimeType: z.string().optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  get parts() {
    return z.array(MessagePartSchema).optional();
  },
});

export type MessagePart = z.infer<typeof MessagePartSchema>;

/** `messages.get` with `format=full`. `internalDate` is epoch ms, as a string. */
export const MessageSchema = z.object({
  id: z.string(),
  internalDate: z.string().regex(/^\d+$/),
  payload: MessagePartSchema,
});

export type GmailMessage = z.infer<typeof MessageSchema>;

/** `messages.list`: ids only, newest first. A query with no match has no `messages`. */
export const ListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

export interface MessageList {
  readonly ids: string[];
  readonly nextPageToken?: string | undefined;
}

/** The two calls the reader makes; a test fakes them without the network. */
export interface GmailClient {
  list(query: string, maxResults: number, pageToken?: string): Promise<MessageList>;
  get(id: string): Promise<GmailMessage>;
}
