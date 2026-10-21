import { WebClientService } from "arrmatura-web";
import type { StoredAuditEntry } from "tg-firebase/types";
import type { ApiService } from "./ApiService";

/**
 * The Audit page's data: the newest `audit` entries, read on open and on Refresh.
 * Mounted as `<AuditService Ref="audit" api="@api" />`.
 */
export class AuditService extends WebClientService {
  declare api: ApiService;

  entries: StoredAuditEntry[] | null = null;
  loading = false;
  error: string | null = null;

  override __init(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.up({ loading: true, error: null });
    try {
      const entries = (await this.api.call("loadAudit")) as StoredAuditEntry[];
      this.up({ entries, loading: false });
    } catch (error) {
      this.logError(error);
      this.up({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
