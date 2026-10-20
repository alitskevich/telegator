import { WebClientService } from "arrmatura-web";
import { hasRole } from "tg-enums/roles";
import { resources } from "tg-rc/web";

/**
 * The console's one way to the API, and the source of who the operator is.
 * Mounted once as `<ApiService Ref="api" auth="@auth" />`, where `@auth` is the
 * platform's `FirebaseService`. `access` comes from the API, not the token:
 * only the API can read whether the account is enabled.
 */

export type Access = "pending" | "signedOut" | "granted" | "denied";

export interface Operator {
  readonly email: string | null;
  readonly roles: readonly string[];
}

const WHOAMI = "whoami";

/** The part of the platform's `FirebaseService` this service uses. */
type FirebaseAuth = {
  readonly isAuthorized: boolean;
  invokeApi(data: unknown): Promise<unknown>;
  signOut(): Promise<void>;
};

/** The HTTP status the API answered with, when the call failed at the API. */
const statusOf = (error: unknown): number | undefined =>
  (error as { status?: unknown } | null)?.status as number | undefined;

const isUnauthenticated = (error: unknown) => statusOf(error) === 401;
const isForbidden = (error: unknown) => statusOf(error) === 403;

export interface RunOptions {
  /** What `busy` is keyed by — one row's button, not the whole table's. Defaults to the action. */
  readonly key?: string;
  /** The success toast; omitted when the result is already on screen. */
  readonly success?: (result: unknown) => string;
}

export class ApiService extends WebClientService {
  declare auth: FirebaseAuth;

  access: Access = "pending";
  user: Operator | null = null;
  /** Why access was denied: `disabled` or `forbidden`, the API's own words. */
  denial: string | null = null;
  /** In-flight actions, by `RunOptions.key`, so each button can show it is working. */
  busy: Readonly<Record<string, boolean>> = {};

  #checking = false;

  override __init(): void {
    this.subscribeTo("auth", () => this.sync());
    this.sync();
  }

  get canEdit(): boolean {
    return hasRole(this.principal, "editor");
  }

  get canAdmin(): boolean {
    return hasRole(this.principal, "admin");
  }

  private get principal() {
    return this.user === null ? null : { roles: this.user.roles, enabled: true };
  }

  /** A read, or anything whose result the caller renders itself. Throws on failure. */
  async call(action: string, input?: unknown): Promise<unknown> {
    try {
      return await this.auth.invokeApi({ action, input });
    } catch (error) {
      if (isUnauthenticated(error)) this.up({ access: "signedOut", user: null });
      throw error;
    }
  }

  /**
   * An operator's action: refused while the same one is in flight, announced
   * when it lands, and — on failure — announced until dismissed or retried.
   * Answers the result, or `undefined` when it failed.
   */
  async run(action: string, input?: unknown, options: RunOptions = {}): Promise<unknown> {
    const key = options.key ?? action;
    if (this.busy[key] === true) return undefined;

    // Close the last failure first, so it is not read as the answer to this press.
    const failureId = `failed:${key}`;
    this.emit("toaster.close()", { id: failureId });
    this.up({ busy: { ...this.busy, [key]: true } });

    try {
      const result = await this.call(action, input);
      if (options.success !== undefined) {
        this.toast({ message: options.success(result), level: "info" });
      }
      return result;
    } catch (error) {
      this.toast({
        id: failureId,
        message: error instanceof Error ? error.message : resources.toasts.failed,
        level: "error",
        timeout: -1,
      });
      return undefined;
    } finally {
      const { [key]: _done, ...rest } = this.busy;
      this.up({ busy: rest });
    }
  }

  private sync(): void {
    if (!this.auth.isAuthorized) {
      if (this.access !== "signedOut") this.up({ access: "signedOut", user: null, denial: null });
      return;
    }

    if (this.access === "granted" || this.access === "denied" || this.#checking) return;
    void this.whoami();
  }

  private async whoami(): Promise<void> {
    this.#checking = true;
    try {
      const user = (await this.call(WHOAMI)) as Operator;
      this.up({ access: "granted", user, denial: null });
    } catch (error) {
      if (isForbidden(error)) {
        this.up({ access: "denied", denial: error instanceof Error ? error.message : null });
      } else if (!isUnauthenticated(error)) {
        // The API is down or misconfigured: say so, rather than loop on sign-in.
        this.logError(error);
        this.up({ access: "denied", denial: error instanceof Error ? error.message : null });
      }
    } finally {
      this.#checking = false;
    }
  }
}
