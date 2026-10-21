import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { videos } from "tg-firebase/db";

/**
 * `npm run youtube:absorb` — the YouTube absorber's local half. The `youtube`
 * function leaves transcripts in `videos`; this hands them to the yt-absorb agent:
 *
 *   1. writes each `fetched` transcript to packages/tg-youtube/input/yt-<id>.md
 *   2. runs the agent, which merges input/ into ./docs and moves each file to done/
 *   3. marks `absorbed` every video whose file reached done/
 *
 * `docs` is a symlink to the target docs folder; the agent may edit its repo.
 * Firestore is the emulator when FIRESTORE_EMULATOR_HOST is set, else production.
 */

const HOME = resolve(import.meta.dirname, "../packages/tg-youtube");
const file = (dir: "input" | "done", id: string) => join(HOME, dir, `yt-${id}.md`);

/** Marks the archived transcripts absorbed and writes the others to input/. */
async function sync(): Promise<void> {
  for (const video of await videos.listByStatus("fetched")) {
    if (existsSync(file("done", video.id))) {
      await videos.patch(video.id, { status: "absorbed" });
      console.log(`  ✓ ${video.title}`);
    } else if (!existsSync(file("input", video.id))) {
      await writeFile(file("input", video.id), video.transcript ?? "");
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(HOME, "docs"))) {
    throw new Error("no packages/tg-youtube/docs: link it to the docs folder first");
  }
  await mkdir(join(HOME, "input"), { recursive: true });
  await mkdir(join(HOME, "done"), { recursive: true });

  await sync();
  const waiting = readdirSync(join(HOME, "input")).filter((f) => f.endsWith(".md")).length;
  if (waiting === 0) {
    console.log("nothing to absorb");
    return;
  }

  console.log(`absorbing ${waiting} transcript(s)`);
  const agent = spawnSync(
    "claude",
    [
      ...["--agent", "yt-absorb", "-p", "Absorb input/ into ./docs"],
      ...["--add-dir", dirname(realpathSync(join(HOME, "docs")))],
      ...["--permission-mode", "acceptEdits"],
    ],
    { cwd: HOME, stdio: "inherit" },
  );
  await sync();
  if (agent.status !== 0) throw new Error(`the yt-absorb agent exited ${agent.status}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
