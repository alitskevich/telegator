/**
 * The slice of `arrmatura-web` the console calls, typed.
 *
 * The package ships TypeScript source written to looser compiler settings than
 * this repository's (`noImplicitAny`, `noImplicitOverride`, `.xml` imports), so
 * letting `tsc` follow it would fail the gate on code nobody here wrote. The
 * root `tsconfig.json` maps the package name to this file instead; esbuild
 * ignores that mapping and bundles the real source. Every member below is
 * checked against `node_modules/arrmatura-web` — add one here before using it.
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
