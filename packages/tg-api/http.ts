import { AuthorizationError, sessionFromIdToken } from "tg-auth/session";
import type { IdTokenVerifier, UserStatusReader } from "tg-ports/auth";
import type { Logger } from "tg-utils/logger";
import { ZodError, z } from "zod";
import { ACTION_NAMES, ACTIONS, type ApiPorts } from "./actions";

/**
 * §8.4 — the one HTTP route: `POST /rpc` with `{ action, input }`, answered with
 * `{ result }` or `{ error }`.
 *
 * One route rather than one per action, because the actions are already a
 * closed, validated registry: a route per action would restate it in API
 * Gateway, and the two lists would drift. The transport knows nothing of AWS —
 * `tg-api/handler.ts` adapts the Lambda event to this and back.
 */

export const HTTP_STATUS = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  internal: 500,
} as const;

export interface RpcRequest {
  /** The raw `Authorization` header, if any. */
  readonly authorization: string | undefined;
  readonly body: string | undefined;
}

export interface RpcResponse {
  readonly status: number;
  readonly body: string;
}

export interface RpcDeps {
  readonly ports: ApiPorts;
  readonly verifier: IdTokenVerifier;
  readonly status: UserStatusReader;
  readonly logger: Logger;
}

export const RpcBodySchema = z.object({
  action: z.enum(ACTION_NAMES),
  input: z.unknown().optional(),
});

const BEARER = /^Bearer\s+(\S+)$/i;

/** The token from `Authorization: Bearer <token>`; anything else is no token. */
export const bearerToken = (header: string | undefined): string | undefined =>
  header === undefined ? undefined : BEARER.exec(header.trim())?.[1];

const reply = (status: number, payload: unknown): RpcResponse => ({
  status,
  body: JSON.stringify(payload),
});

/**
 * Parse the body, or `undefined`. Malformed JSON is the caller's mistake and is
 * answered as one, not as a 500.
 */
function parseBody(body: string | undefined): z.infer<typeof RpcBodySchema> | undefined {
  try {
    const parsed = RpcBodySchema.safeParse(JSON.parse(body ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function handleRpc(request: RpcRequest, deps: RpcDeps): Promise<RpcResponse> {
  const session = await sessionFromIdToken(bearerToken(request.authorization), deps.verifier);

  // Every action needs at least `viewer`, so an anonymous caller is refused
  // before the body is read: it learns neither the action names nor which
  // inputs would validate.
  if (session === null) return reply(HTTP_STATUS.unauthorized, { error: "unauthenticated" });

  const call = parseBody(request.body);
  if (call === undefined) return reply(HTTP_STATUS.badRequest, { error: "malformed request" });

  try {
    const result = await ACTIONS[call.action](call.input, {
      ...deps.ports,
      auth: { session, status: deps.status },
    });
    // `undefined` is not JSON; a void action answers `null`.
    return reply(HTTP_STATUS.ok, { result: result ?? null });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      const status =
        error.reason === "unauthenticated" ? HTTP_STATUS.unauthorized : HTTP_STATUS.forbidden;
      return reply(status, { error: error.reason });
    }

    if (error instanceof ZodError) {
      return reply(HTTP_STATUS.badRequest, { error: `invalid input: ${z.prettifyError(error)}` });
    }

    const message = error instanceof Error ? error.message : String(error);
    deps.logger.error("action failed", { action: call.action, sub: session.sub, error: message });

    // The callers are signed-in operators, and "no such message: x" is the
    // answer they need; the console shows it in the failure toast.
    return reply(HTTP_STATUS.internal, { error: message });
  }
}
