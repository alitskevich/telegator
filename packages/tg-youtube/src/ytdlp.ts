import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseJson3, pickCaptionTrack, renderTranscript, watchUrl } from "./captions";
import type { FetchOutcome } from "./types";

/**
 * Captions through yt-dlp, the standalone build, downloaded into the temp dir
 * on first use: the Linux one in Cloud Functions, the macOS one locally.
 */

const ASSET = process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp_linux";
const RELEASE = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`;
const BINARY = join(tmpdir(), "yt-dlp");
/** Only the temp dir is writable in Cloud Functions. */
const COMMON = ["--no-warnings", "--cache-dir", join(tmpdir(), "yt-dlp-cache")];

/** Transcripts in this language when the video has it; the spoken language otherwise. */
const LANG_PREF = "en";

function run(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`yt-dlp exited ${code}\n${stderr.trim() || stdout.trim()}`)),
    );
  });
}

async function ensureYtdlp(): Promise<string> {
  const cached = await access(BINARY).then(
    () => true,
    () => false,
  );
  if (cached) return BINARY;
  const response = await fetch(RELEASE, { redirect: "follow" });
  if (!response.ok) throw new Error(`yt-dlp download failed: HTTP ${response.status}`);
  // Renamed into place, so a cut download never passes for the binary.
  const part = `${BINARY}.part`;
  await writeFile(part, Buffer.from(await response.arrayBuffer()));
  await chmod(part, 0o755);
  await rename(part, BINARY);
  return BINARY;
}

/** yt-dlp's reason for a video nobody can watch (removed, blocked, private), else null. */
export function unavailableReason(message: string): string | null {
  const reason = message.match(
    /(?:Video unavailable|This video is unavailable|This video has been removed|Private video)[^\n]*/,
  );
  return reason ? reason[0].trim() : null;
}

const InfoSchema = z.object({
  title: z.string().optional(),
  channel: z.string().optional(),
  uploader: z.string().optional(),
  duration: z.number().optional(),
  language: z.string().nullish(),
  subtitles: z.record(z.string(), z.unknown()).nullish(),
  automatic_captions: z.record(z.string(), z.unknown()).nullish(),
});

async function fetchCaptions(ytdlp: string, videoId: string): Promise<FetchOutcome> {
  const url = watchUrl(videoId);
  const info = InfoSchema.parse(
    JSON.parse(await run(ytdlp, [...COMMON, "-J", "--skip-download", url])),
  );
  const track = pickCaptionTrack({
    manual: Object.keys(info.subtitles ?? {}),
    auto: Object.keys(info.automatic_captions ?? {}),
    langPref: LANG_PREF,
    videoLanguage: info.language ?? "",
  });
  if (!track) return { status: "skipped", note: "no captions" };

  const dir = await mkdtemp(join(tmpdir(), "yt-subs-"));
  try {
    await run(ytdlp, [
      ...COMMON,
      ...["--skip-download", "--write-auto-subs", "--write-subs"],
      ...["--sub-langs", track.lang, "--sub-format", "json3"],
      ...["-o", join(dir, "%(id)s.%(ext)s"), url],
    ]);
    const raw = await readFile(join(dir, `${videoId}.${track.lang}.json3`), "utf8").catch(() => "");
    const chunks = raw ? parseJson3(raw) : [];
    if (chunks.length === 0) return { status: "skipped", note: "no captions" };

    const video = {
      id: videoId,
      title: info.title ?? videoId,
      channel: info.channel ?? info.uploader ?? "",
      duration: info.duration,
    };
    return {
      status: "fetched",
      lang: track.lang,
      kind: track.kind,
      transcript: renderTranscript(video, track.lang, chunks),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One video's transcript. Any error but an unavailable video is thrown, to retry next run. */
export async function fetchTranscript(videoId: string): Promise<FetchOutcome> {
  try {
    return await fetchCaptions(await ensureYtdlp(), videoId);
  } catch (error) {
    const note = unavailableReason(String(error));
    if (note === null) throw error;
    return { status: "unavailable", note };
  }
}
