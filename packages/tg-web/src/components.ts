import { components as vibe } from "arrmatura-vibe";
import cml from "./index.cml";
import { ApiService } from "./services/ApiService";
import { AuditService } from "./services/AuditService";
import { GridService } from "./services/GridService";
import { ItemService } from "./services/ItemService";
import { PipelineService } from "./services/PipelineService";
import { RecordService } from "./services/RecordService";

/**
 * The console's registry: every template (generated, `./index.cml.ts`), every
 * service class, and the vibe DevTools. A tag resolves only once registered here.
 */
export const components = [
  ...cml,
  ...vibe,
  ApiService,
  AuditService,
  GridService,
  ItemService,
  PipelineService,
  RecordService,
];
