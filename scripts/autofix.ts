import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { editItem } from "tg-actions/dashboard/queues";
import { listErrors, saveDiagnosis } from "tg-firebase/errors";
import { runItemNow } from "tg-firebase/ingest";
import type { StoredIngestItem } from "tg-firebase/types";
import { z } from "zod";

/**
 * Auto-fix: reads the `ingest` errors, asks Claude Code (`claude -p`, run in
 * this repo) for each distinct failure's root cause, and applies its fix.
 *
 * Errors are grouped by stage and message, so one failure costs one run. Claude
 * answers `data` (the payloads are wrong: here are corrected ones), `code` (the
 * code is wrong: it edits the repo and keeps the gates passing) or `none`
 * (transient, or not fixable here).
 *
 * Dry run unless `--apply`: Claude runs in plan mode and nothing is written.
 * With `--apply`, Claude may edit code, a corrected payload is saved through
 * `editItem` (so its stage's schema must accept it) and the item runs again, and
 * Claude's reading is kept as each item's diagnosis. A code fix runs only once
 * deployed (the emulator reloads on `npm run build`); then *Replay* the errors.
 *
 *   npm run autofix                    # dry run
 *   npm run autofix -- --apply --max 20
 *
 * Firestore is the emulator when FIRESTORE_EMULATOR_HOST is set, else production.
 */

const ROOT = resolve(import.meta.dirname, "..");
/** How many items of one group Claude is shown, and how much of each payload. */
const SAMPLES = 5;
const PAYLOAD_CHARS = 4000;
/** What Claude may use with `--apply`: read, edit, and the four gates. */
const APPLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash(npx tsc:*)",
  "Bash(npm test:*)",
  "Bash(npx biome:*)",
  "Bash(npm run build:*)",
];

const OutcomeSchema = z.object({
  kind: z.enum(["data", "code", "none"]),
  /** One sentence an operator reads first. */
  summary: z.string(),
  cause: z.string(),
  /** What was changed, or what an operator should do. */
  fix: z.string(),
  /** `data` only: each shown item's corrected payload, whole. */
  fixes: z.array(z.object({ id: z.string(), raw: z.record(z.string(), z.unknown()) })).default([]),
});

type Outcome = z.infer<typeof OutcomeSchema>;

const ClaudeResultSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

function prompt(items: readonly StoredIngestItem[], apply: boolean): string {
  const [first] = items;
  if (first === undefined) throw new Error("empty group");
  const samples = items.slice(0, SAMPLES).map((item) => ({
    id: item.id,
    attempts: item.retryCount,
    payload: JSON.stringify(item.raw).slice(0, PAYLOAD_CHARS),
  }));
  return [
    `${items.length} item(s) of the \`${first.stage}\` stage used up their attempts in the \`ingest\` queue with the same error.`,
    "Find the root cause in this repository; docs/telegator.md explains the system.",
    "",
    `Error: ${first.error ?? ""}`,
    `Cause: ${first.cause ?? ""}`,
    first.diagnosis ? `An earlier model reading: ${JSON.stringify(first.diagnosis)}` : "",
    `Items: ${JSON.stringify(samples, null, 2)}`,
    "",
    "Answer with one kind:",
    "- data: the payloads are wrong and the code is right. Put each shown item's corrected payload, whole, in `fixes`. Edit no file.",
    apply
      ? "- code: the code is wrong. Fix it, and keep the four gates of CLAUDE.md passing."
      : "- code: the code is wrong. Edit no file; describe the fix in `fix`.",
    "- none: transient (network, rate limit, an outside service) or not fixable here.",
  ].join("\n");
}

function askClaude(items: readonly StoredIngestItem[], apply: boolean): Outcome {
  const args = [
    "-p",
    prompt(items, apply),
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(z.toJSONSchema(OutcomeSchema, { target: "draft-7" })),
    "--permission-mode",
    apply ? "acceptEdits" : "plan",
    ...(apply ? ["--allowedTools", ...APPLY_TOOLS] : []),
  ];
  const run = spawnSync("claude", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`claude exited ${run.status}: ${run.stderr}`);

  const reply = ClaudeResultSchema.parse(JSON.parse(run.stdout));
  if (reply.is_error === true) throw new Error(`claude failed: ${reply.result ?? ""}`);
  return OutcomeSchema.parse(reply.structured_output ?? JSON.parse(reply.result ?? ""));
}

/** Saves each corrected payload a shown item got, and runs the item again. */
async function applyData(items: readonly StoredIngestItem[], outcome: Outcome): Promise<void> {
  const shown = new Set(items.slice(0, SAMPLES).map((item) => item.id));
  for (const { id, raw } of outcome.fixes) {
    if (!shown.has(id)) continue;
    try {
      await editItem({ id, raw });
      console.log(
        `  ${id}: payload fixed, ${(await runItemNow(id)) ? "running again" : "not waiting"}`,
      );
    } catch (error) {
      console.log(`  ${id}: fix refused: ${String(error)}`);
    }
  }
}

function groupByFailure(items: readonly StoredIngestItem[]): StoredIngestItem[][] {
  const groups = new Map<string, StoredIngestItem[]>();
  for (const item of items) {
    const key = `${item.stage}\n${item.error ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const maxAt = process.argv.indexOf("--max");
  const max = maxAt === -1 ? 20 : Number(process.argv[maxAt + 1]);
  console.log(
    `firestore=${process.env.FIRESTORE_EMULATOR_HOST ?? "production"} ${apply ? "APPLY" : "dry run"}`,
  );

  const groups = groupByFailure(await listErrors(max));
  if (groups.length === 0) console.log("no errors");

  for (const items of groups) {
    const [first] = items;
    if (first === undefined) continue;
    console.log(`\n${first.stage}: ${items.length} × ${first.error ?? ""}`);
    try {
      const outcome = askClaude(items, apply);
      console.log(
        `  ${outcome.kind}: ${outcome.summary}\n  cause: ${outcome.cause}\n  fix: ${outcome.fix}`,
      );
      if (!apply) continue;
      const { summary, cause, fix } = outcome;
      for (const item of items) await saveDiagnosis(item.id, { summary, cause, fix });
      if (outcome.kind === "data") await applyData(items, outcome);
      if (outcome.kind === "code") console.log("  deploy (or build, on the emulator), then Replay");
    } catch (error) {
      console.log(`  failed: ${String(error)}`);
    }
  }
}

await main();
