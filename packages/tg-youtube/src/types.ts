import type { CaptionKind } from "tg-domain/video";

export interface PlaylistItem {
  /** The playlist entry, which removal needs; one video may be in a playlist twice. */
  itemId: string;
  videoId: string;
  title: string;
}

export interface Playlist {
  items(): Promise<PlaylistItem[]>;
  remove(itemId: string): Promise<void>;
}

/** What one fetch settles. A thrown error settles nothing: the video stays `todo`. */
export type FetchOutcome =
  | { status: "fetched"; lang: string; kind: CaptionKind; transcript: string }
  | { status: "skipped" | "unavailable"; note: string };

export type TranscriptFetcher = (videoId: string) => Promise<FetchOutcome>;
