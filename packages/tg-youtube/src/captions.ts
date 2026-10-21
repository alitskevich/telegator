import type { CaptionKind } from "tg-domain/video";
import { z } from "zod";
import type { CaptionTracks, Chunk, VideoInfo } from "./types";

/** Caption track choice and transcript rendering. Pure. */

/** Caption lines are merged into bullets of about this length. */
const CHUNK_SECONDS = 25;

export const watchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

/**
 * Chooses one caption track. A popular video carries 150+ auto-translated
 * languages, so this picks one rather than letting yt-dlp download the set.
 *
 * An `-orig` track is the caption in a language actually spoken; every other
 * auto caption is a machine translation of it, so `-orig` always wins. A video
 * with dubbed audio carries one `-orig` track per audio language.
 */
export function pickCaptionTrack({
  manual = [],
  auto = [],
  langPref = "",
  videoLanguage = "",
}: CaptionTracks): { lang: string; kind: CaptionKind } | null {
  const wanted: string[] = [];
  if (langPref) wanted.push(`${langPref}-orig`, langPref);
  for (const lang of new Set([videoLanguage, videoLanguage.split("-")[0] ?? ""])) {
    if (lang) wanted.push(`${lang}-orig`, lang);
  }

  // With `-orig` tracks present, every other auto track but the spoken languages is a
  // translation, and YouTube answers those with HTTP 429, so none of them may match.
  const origAuto = auto.filter((l) => l.endsWith("-orig"));
  const spoken =
    origAuto.length > 0 ? origAuto.flatMap((l) => [l, l.slice(0, -"-orig".length)]) : auto;

  for (const lang of wanted) {
    if (manual.includes(lang)) return { lang, kind: "manual" };
    if (spoken.includes(lang)) return { lang, kind: "auto" };
  }
  // Nothing preferred matched: fall back to whatever original-audio track exists.
  const orig = manual.find((l) => l.endsWith("-orig")) ?? origAuto[0];
  if (orig) return { lang: orig, kind: manual.includes(orig) ? "manual" : "auto" };
  if (manual[0] !== undefined) return { lang: manual[0], kind: "manual" };
  if (auto.includes("en")) return { lang: "en", kind: "auto" };
  return auto[0] !== undefined ? { lang: auto[0], kind: "auto" } : null;
}

const Json3Schema = z.object({
  events: z
    .array(
      z.object({
        tStartMs: z.number().optional(),
        segs: z.array(z.object({ utf8: z.string().optional() })).optional(),
      }),
    )
    .default([]),
});

/** yt-dlp's json3 caption file, merged into chunks of about `CHUNK_SECONDS`. */
export function parseJson3(raw: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const event of Json3Schema.parse(JSON.parse(raw)).events) {
    const text = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue; // newline-only padding events
    const start = Math.floor((event.tStartMs ?? 0) / 1000);
    const last = chunks.at(-1);
    if (last && start - last.start < CHUNK_SECONDS) last.text += ` ${text}`;
    else chunks.push({ start, text });
  }
  return chunks;
}

export function timestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** The transcript the absorb agent reads: each bullet links to its moment in the video. */
export function renderTranscript(video: VideoInfo, lang: string, chunks: readonly Chunk[]): string {
  const url = watchUrl(video.id);
  const meta = [
    video.channel,
    video.duration ? timestamp(video.duration) : null,
    `captions: ${lang}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = chunks
    .map((c) => `- [${timestamp(c.start)}](${url}&t=${c.start}s) ${c.text}`)
    .join("\n");
  return `# ${video.title}\n\n${url}\n\n> ${meta}\n\n${body}\n`;
}
