import { App, type AppProps } from "aws-cdk-lib";
import { TelegatorAppStack } from "./app-stack";
import { TelegatorAuthStack } from "./auth-stack";
import { resolveConfig } from "./config";
import { TelegatorDataStack } from "./data-stack";
import { TelegatorPipelineStack } from "./pipeline-stack";
import { TelegatorQueueStack } from "./queue-stack";

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
export function createApp(props?: AppProps): App {
  // `props` exists for tests: each needs its own `outdir`, because
  // `NodejsFunction` stages a bundle on disk and parallel vitest workers
  // synthesising into one shared cdk.out collide over the staging directory.
  const app = new App(props);
  const config = resolveConfig(app);

  // §9.1 L806 — Data, Queue and Auth have no dependencies on each other.
  const data = new TelegatorDataStack(app, "TelegatorDataStack", { config });
  const queues = new TelegatorQueueStack(app, "TelegatorQueueStack", { config });
  const auth = new TelegatorAuthStack(app, "TelegatorAuthStack", { config });

  // ...then Pipeline, which consumes both. The constructs are passed rather
  // than imported by name, so CDK emits the cross-stack exports itself.
  const pipeline = new TelegatorPipelineStack(app, "TelegatorPipelineStack", {
    config,
    data,
    queues,
  });

  // ...and App last, which consumes every other stack.
  new TelegatorAppStack(app, "TelegatorAppStack", { config, data, queues, auth, pipeline });

  return app;
}
