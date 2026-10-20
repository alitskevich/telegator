import { Runtime } from "aws-cdk-lib/aws-lambda";
import { OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";

/**
 * What every Lambda in this build shares — the pipeline's stages and the
 * dashboard API alike — so a runtime bump or a bundling fix lands once.
 */

/** §7.5 L690 — "All Node.js 22, ARM64, bundled with esbuild." */
export const RUNTIME = Runtime.NODEJS_22_X;

/**
 * Bundling settings shared by every function.
 *
 * `forceDockerBundling: false` is not a preference: there is no Docker on the
 * build machine, and CDK falls back to a container image when it cannot find a
 * local esbuild. With esbuild installed as a devDependency it bundles in
 * process, which is what keeps `cdk synth` runnable here at all.
 */
export const BUNDLING = {
  forceDockerBundling: false,
  minify: true,
  sourceMap: true,
  // The Node 22 runtime ships the AWS SDK v3, so bundling it would add
  // megabytes to every artifact for no behavioural gain.
  externalModules: ["@aws-sdk/*"] as string[],
  format: OutputFormat.ESM,
  // ESM output needs this shim: several transitive dependencies still call
  // `require`, which does not exist in an ESM module scope.
  banner: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
} as const;
