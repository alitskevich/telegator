import cml from "./index.cml";
import { ApiService } from "./services/ApiService";
import { AuditService } from "./services/AuditService";
import { GridService } from "./services/GridService";
import { ItemService } from "./services/ItemService";
import { PipelineService } from "./services/PipelineService";
import { RecordService } from "./services/RecordService";

/**
 * The console's registry: every template (generated, `./index.cml.ts`) and
 * every service class. A tag resolves only once registered here.
 */
export const components = [
  ...cml,
  ApiService,
  AuditService,
  GridService,
  ItemService,
  PipelineService,
  RecordService,
];
