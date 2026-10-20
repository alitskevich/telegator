import { WebClientService } from "arrmatura-web";
import type { Overview } from "tg-actions/dashboard/overview";
import { conicGradient, type PieSlice, type Slice, toPieSlices } from "tg-utils/ui/pie";
import type { ApiService } from "./ApiService";

/**
 * The Dashboard page's data: one `overview` read, refreshed on a timer while the
 * page is open. Mounted as `<OverviewService Ref="overview" api="@api" />`.
 */

/** How often the dashboard re-reads its counters. */
export const OVERVIEW_REFRESH_MS = 60_000;

export interface Donut {
  readonly slices: readonly PieSlice[];
  /** The chart itself, as a CSS background. */
  readonly background: string;
}

const donut = (values: readonly Slice[] | undefined): Donut => {
  const slices = toPieSlices(values ?? []);
  return { slices, background: conicGradient(slices) };
};

/** The skip split by reason, e.g. "category 10 · low 14". */
export const skipNote = (overview: Overview | null): string =>
  Object.entries(overview?.skipped.byReason ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(" · ");

export class OverviewService extends WebClientService {
  declare api: ApiService;

  data: Overview | null = null;
  loading = false;
  error: string | null = null;
  updatedAt: number | null = null;

  declare statusChart: Donut;
  declare categoryChart: Donut;
  declare skipped: string;

  constructor() {
    super();
    this.__defineCalculatedProperties({
      "statusChart(data)": (data: Overview | null) => donut(data?.statusSlices),
      "categoryChart(data)": (data: Overview | null) => donut(data?.categorySlices),
      "skipped(data)": skipNote,
    });
  }

  override __init(): void {
    void this.load();
    const timer = setInterval(() => void this.load(), OVERVIEW_REFRESH_MS);
    this.defer(() => clearInterval(timer));
  }

  async load(): Promise<void> {
    this.up({ loading: true, error: null });
    try {
      const data = (await this.api.call("overview")) as Overview;
      this.up({ data, loading: false, updatedAt: Date.now() });
    } catch (error) {
      this.logError(error);
      this.up({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
