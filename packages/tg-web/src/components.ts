import cml from "./index.cml";
import { ApiService } from "./services/ApiService";
import { GridService } from "./services/GridService";
import { OverviewService } from "./services/OverviewService";
import { PipelineService } from "./services/PipelineService";

/**
 * The console's registry: every template (generated, `./index.cml.ts`) and
 * every service class. A tag resolves only once registered here.
 */
export const components = [...cml, ApiService, GridService, OverviewService, PipelineService];
