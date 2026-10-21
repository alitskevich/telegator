import { onRequest } from "firebase-functions/v2/https";
import { REGION } from "tg-configs/firebase";
import { hasRole } from "tg-enums/roles";
import { isEmulator } from "tg-firebase/app";
import { operatorFrom } from "tg-firebase/operators";
import { log } from "tg-utils/logger";
import { ZodError, z } from "zod";
import { ACTIONS } from "./actions";

/**
 * The console's one endpoint: `POST {data: {action, input}}` answers
 * `{data: {ok, result}}`, or `{data: {ok: false, error}}` with 400, 401, 403 or 500.
 */

const ORIGINS = new Set([
  "https://telegator-581db.web.app",
  "https://telegator-581db.firebaseapp.com",
]);
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const CallSchema = z.object({
  data: z.object({ action: z.string(), input: z.unknown().optional() }),
});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function dispatch(body: unknown, authorization: string | undefined): Promise<unknown> {
  const call = CallSchema.safeParse(body);
  if (!call.success) throw new HttpError(400, "malformed request");
  const { action, input } = call.data.data;

  const entry = ACTIONS[action];
  if (entry === undefined) throw new HttpError(400, `unknown action: ${action}`);

  const operator = await operatorFrom(authorization);
  if (operator === null) throw new HttpError(401, "unauthenticated");
  if (!operator.enabled) throw new HttpError(403, "disabled");
  const [role, run] = entry;
  if (!hasRole(operator, role)) throw new HttpError(403, "forbidden");

  try {
    return await run(input, operator);
  } catch (error) {
    if (error instanceof ZodError)
      throw new HttpError(400, `invalid input: ${z.prettifyError(error)}`);
    log.error("action failed", { action, uid: operator.uid, error: String(error) });
    throw new HttpError(500, error instanceof Error ? error.message : String(error));
  }
}

export const api = onRequest({ region: REGION, timeoutSeconds: 300 }, async (req, res) => {
  const origin = req.get("Origin");
  if (origin !== undefined && (ORIGINS.has(origin) || (isEmulator && DEV_ORIGIN.test(origin)))) {
    res.set({ "Access-Control-Allow-Origin": origin, Vary: "Origin" });
  }
  res.set({
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send({ data: { ok: false, error: { message: "POST only" } } });
    return;
  }

  try {
    const result = await dispatch(req.body, req.get("Authorization"));
    res.send({ data: { ok: true, result: result ?? null } });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    res.status(status).send({
      data: { ok: false, error: { code: status, message: String((error as Error).message) } },
    });
  }
});
