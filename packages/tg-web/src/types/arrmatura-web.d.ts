/**
 * The slice of `arrmatura-web` the console calls, typed. The package's source
 * fails this repo's stricter `tsc`, so `tsconfig.json` maps it here; esbuild
 * still bundles the real source. Declare a member here before using it.
 */
declare module "arrmatura-web" {
  export type Delta = Record<string, unknown>;

  /** Toast entry, as `ToastService.send` reads it. `timeout: -1` keeps it until dismissed. */
  export interface LogEntry {
    readonly message: string;
    readonly level?: "log" | "error" | "warning" | "info" | "";
    readonly id?: string;
    readonly details?: string;
    readonly timeout?: number;
  }

  /** `arrmatura`'s `Component` — re-exported by `arrmatura-web`. */
  export class Component {
    __init(): void;
    get(key: string): unknown;
    /** The only way to change state: a direct assignment does not re-render. */
    up(delta: Delta | Promise<Delta> | null): void;
    touch(): void;
    emit(key: string, data?: Delta): void;
    subscribeTo(refId: string, fn: () => void): void;
    getComponentByRef(refId: string): unknown;
    defer(fn: () => void): void;
    /** Keys are `"name(dep1,dep2)"`; the function receives the dependencies in that order. */
    __defineCalculatedProperties(bundle: Record<string, (...args: never[]) => unknown>): void;
    log<T>(value: T, ...args: unknown[]): T;
    logError<T>(error: T, ...args: unknown[]): T;
  }

  export interface ClientStorage {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    clear(): void;
  }

  export class WebClientService extends Component {
    persistence: "local" | "session" | "transient";
    readonly storage: ClientStorage;
    readonly localStorage: ClientStorage;
    readonly sessionStorage: ClientStorage;
    toast(entry: LogEntry): void;
  }

  export interface WebAppOptions {
    readonly template?: string;
    readonly components?: readonly unknown[];
    readonly functions?: Readonly<Record<string, (...args: never[]) => unknown>>;
    readonly resources?: unknown;
    readonly rootElement?: HTMLElement;
  }

  export function launchPlatformApp(options?: WebAppOptions): void;
}
