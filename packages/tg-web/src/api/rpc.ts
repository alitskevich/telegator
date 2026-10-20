/**
 * §8.4 — the browser's side of `tg-api/http.ts`: `POST { action, input }` with
 * the ID token as a bearer credential, answered with `{ result }` or
 * `{ error }`.
 */

/** The API's own refusal, carrying the HTTP status so the caller can tell 401 from 403. */
export class RpcError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

export const isUnauthenticated = (error: unknown): boolean =>
  error instanceof RpcError && error.status === UNAUTHORIZED;

export const isForbidden = (error: unknown): boolean =>
  error instanceof RpcError && error.status === FORBIDDEN;

interface Answer {
  readonly result?: unknown;
  readonly error?: string;
}

async function readAnswer(response: Response): Promise<Answer> {
  try {
    return (await response.json()) as Answer;
  } catch {
    // API Gateway's own refusals (the authorizer's 401) are not this API's JSON.
    return {};
  }
}

export async function callRpc(
  fetchImpl: typeof fetch,
  url: string,
  idToken: string,
  action: string,
  input?: unknown,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
    body: JSON.stringify({ action, input }),
  });

  const answer = await readAnswer(response);
  if (!response.ok) {
    throw new RpcError(response.status, answer.error ?? `HTTP ${response.status}`);
  }
  return answer.result;
}
