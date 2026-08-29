import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway `cdk.out` per synthesising test file, and the cleanup that item
 * 4.5 forgot.
 *
 * Each CDK `App` needs its own outdir because `NodejsFunction` stages a bundle
 * on disk, and parallel vitest workers synthesising into one shared `cdk.out`
 * collide over the staging directory. Seven test files had their own copy of
 * this, and none of them removed what it created.
 *
 * The cost is not small: each synth writes five Lambda bundles plus source maps,
 * roughly 9 MB, once per context variant per file per run. Over the course of
 * this build that filled the disk — and the way it announced itself was the test
 * suite becoming intermittent, which reads as a flaky test rather than a full
 * volume. Three runs in a row passed, then one failed 33 files.
 */

const created: string[] = [];

export function isolatedOutdir(prefix = "telegator-cdk-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Remove every outdir this worker created. Call it from `afterAll`.
 *
 * `force` so a directory already gone is not an error, and the list is drained
 * so a second call is a no-op rather than a second traversal.
 */
export function removeIsolatedOutdirs(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** For the helper's own test: how many outdirs are awaiting cleanup. */
export const pendingOutdirCount = (): number => created.length;
