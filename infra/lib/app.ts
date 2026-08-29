import { App } from "aws-cdk-lib";
import { TelegatorAuthStack } from "./auth-stack.js";
import { resolveConfig } from "./config.js";
import { TelegatorDataStack } from "./data-stack.js";
import { TelegatorQueueStack } from "./queue-stack.js";

/**
 * Builds the CDK app.
 *
 * No stack is given an `env`. Environment-agnostic stacks are what let
 * `cdk synth` run without credentials, which is the only infrastructure gate
 * available on this machine — so a context lookup (`fromLookup`,
 * `valueFromLookup`) anywhere below this point breaks the build's verification,
 * not just one stack.
 *
 * Stack order is §9.1 L806: Data, Queue, Auth -> Pipeline -> App.
 */
export function createApp(): App {
  const app = new App();
  const config = resolveConfig(app);

  // §9.1 L806 — Data, Queue and Auth have no dependencies on each other.
  new TelegatorDataStack(app, "TelegatorDataStack", { config });
  new TelegatorQueueStack(app, "TelegatorQueueStack", { config });
  new TelegatorAuthStack(app, "TelegatorAuthStack", { config });

  return app;
}
