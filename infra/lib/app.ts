import { App } from "aws-cdk-lib";
import { TelegatorDataStack } from "./data-stack.js";

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

  new TelegatorDataStack(app, "TelegatorDataStack");

  return app;
}
