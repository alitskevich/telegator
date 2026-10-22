import { WebClientService } from "arrmatura-web";
import type { ErrorPreview, ErrorsPage } from "tg-actions/dashboard/types";
import type { StoredAuditEntry } from "tg-firebase/types";
import { resources } from "tg-rc/web";
import { clock } from "../functions";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";
import { asRecord } from "./GridService";
import type { ErrorRow } from "./types";

/**
 * The Audit page's data: the failed `ingest` items an operator may still run,
 * replay or discard, and the newest `audit` entries. Read on open and on Refresh.
 * Mounted as `<AuditService Ref="audit" api="@api" />`.
 */

const DEFAULT_REPLAY_MAX = "10";

const errorRow = (item: ErrorPreview): ErrorRow => ({
  id: item.id,
  ref: item.ref || item.id,
  text: item.text,
  meta: [
    item.stage,
    item.ref || item.id,
    clock(item.failedAt),
    fill(resources.audit.attempts, { count: item.retryCount }),
  ].join(" · "),
  error: item.error ?? "",
  cause: item.cause ?? "",
  diagnosis: item.diagnosis,
  analyseLabel: item.diagnosis === null ? resources.audit.analyse : resources.audit.analyseAgain,
});

interface ValueEvent {
  readonly value?: string;
}

export class AuditService extends WebClientService {
  declare api: ApiService;

  entries: StoredAuditEntry[] | null = null;
  /** The oldest failed items, and their count in all: `null` until read. */
  errors: ErrorsPage | null = null;
  loading = false;
  error: string | null = null;
  replayMax = DEFAULT_REPLAY_MAX;
  /** The error count a purge was armed at; see `purge`. */
  purgeArmedAt: number | null = null;

  get errorRows(): readonly ErrorRow[] | null {
    return this.errors?.items.map(errorRow) ?? null;
  }

  get armedPurge(): boolean {
    return this.purgeArmedAt !== null && this.purgeArmedAt === this.errors?.total;
  }

  get purgeLabel(): string {
    return this.armedPurge
      ? fill(resources.audit.confirmCleanup, { count: this.errors?.total ?? 0 })
      : resources.audit.cleanup;
  }

  override __init(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.up({ loading: true, error: null });
    try {
      const [entries, errors] = await Promise.all([
        this.api.call("loadAudit") as Promise<StoredAuditEntry[]>,
        this.api.call("inspectErrors") as Promise<ErrorsPage>,
      ]);
      this.up({ entries, errors, loading: false });
    } catch (error) {
      this.logError(error);
      this.up({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  setReplayMax(event: ValueEvent): void {
    this.up({ replayMax: event.value ?? "" });
  }

  /** Asks the model why one error happened and how to fix it; the answer stays on the item. */
  async diagnose(event: { readonly id?: string; readonly ref?: string }): Promise<void> {
    if (event.id === undefined) return;
    const ref = event.ref ?? event.id;
    const done = await this.api.run(
      "diagnoseError",
      { id: event.id },
      { key: "diagnose", success: () => fill(resources.toasts.diagnoseError, { ref }) },
    );
    if (done !== undefined) await this.load();
  }

  /** Sends up to `replayMax` errors, oldest first, back to their stages. */
  async replay(): Promise<void> {
    const max = Number(this.replayMax);
    if (!Number.isInteger(max) || max <= 0) return;
    const done = await this.api.run(
      "retryErrors",
      { max },
      { key: "replay", success: (result) => fill(resources.toasts.retryErrors, asRecord(result)) },
    );
    if (done !== undefined) await this.load();
  }

  /**
   * A purge cannot be undone: an error is a post's last copy. So it takes two
   * presses, and the second label names the count. The armed count is held, so a
   * refresh that changes it disarms the purge.
   */
  async purge(): Promise<void> {
    if (!this.armedPurge) {
      this.up({ purgeArmedAt: this.errors?.total ?? null });
      return;
    }

    this.up({ purgeArmedAt: null });
    const done = await this.api.run("purgeErrors", undefined, {
      key: "purge",
      success: (result) => fill(resources.toasts.purgeErrors, asRecord(result)),
    });
    if (done !== undefined) await this.load();
  }
}
