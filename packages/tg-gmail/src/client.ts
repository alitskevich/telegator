import { z } from "zod";
import type { GmailCredentials } from "./credentials";
import { type GmailClient, ListSchema, MessageSchema } from "./types";

/**
 * The Gmail API over the platform `fetch`. The one module here that touches the
 * network, so it holds no logic: query, paging and mapping live in `reader.ts`.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

/** Scrape has 300 s for up to ten sources; one hung call must not eat it all. */
const FETCH_TIMEOUT_MS = 20_000;

const TokenSchema = z.object({ access_token: z.string() });

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

async function accessToken(credentials: GmailCredentials): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return TokenSchema.parse(await (await ok(response, "token refresh")).json()).access_token;
}

/** One access token per client: build one per run, it lives an hour. */
export function createGmailClient(credentials: GmailCredentials): GmailClient {
  let token: Promise<string> | undefined;
  const call = async (url: string, what: string): Promise<unknown> => {
    token ??= accessToken(credentials);
    const headers = { Authorization: `Bearer ${await token}` };
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return (await ok(response, what)).json();
  };

  return {
    async list(query, maxResults, pageToken) {
      const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
      if (pageToken) params.set("pageToken", pageToken);
      const page = ListSchema.parse(await call(`${MESSAGES_URL}?${params}`, "messages list"));
      return { ids: page.messages.map((message) => message.id), nextPageToken: page.nextPageToken };
    },

    async get(id) {
      const url = `${MESSAGES_URL}/${encodeURIComponent(id)}?format=full`;
      return MessageSchema.parse(await call(url, "messages get"));
    },
  };
}
