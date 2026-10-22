# 8. YouTube absorber

A separate flow that turns YouTube videos into knowledge in a docs repository. It shares only the store with the news pipeline.

The owner saves a video to one playlist. A scheduled job fetches its captions. A local coding agent then merges the transcript into topic files.

## 1. Cloud run

- **YT-1** Runs every **6 hours**, only when `YOUTUBE_PLAYLIST_ID` is set. It reads the playlist with the owner's OAuth token (`YOUTUBE_OAUTH`).
- **YT-2** **Intake.** Every playlist video that has no `videos` record is added as `{id, title, status: todo, addedAt: now}`.
- **YT-3** **Fetch.** The **20** oldest `todo` videos (by `addedAt`) get their captions. The outcome sets the status:

| Outcome | Status |
| --- | --- |
| Captions found | `fetched`, with `transcript` |
| No captions | `skipped` (final) |
| Video removed or private | `unavailable` (final) |
| Any other error | stays `todo`; logged as a warning; retried next run |

- **YT-4** **Clean up.** Every playlist entry whose video is past `todo` is removed from the playlist, so the playlist holds only work left. A failed removal is logged and does not stop the run.

## 2. Transcript format

- **YT-5** Markdown: the title, the video link, then one bullet per ~25 seconds of captions. Each bullet links to its moment in the video.
- **YT-6** A track in the spoken language (`-orig`) wins over a machine translation.

## 3. Local absorb

- **YT-7** `youtube:absorb` writes each `fetched` transcript to an input folder and runs the absorb agent. The agent merges each transcript into the docs repo and moves it to `done/`. The script then marks the video `absorbed`.

## 4. Why these choices

- A playlist, not *Watch Later*: the API stopped exposing *Watch Later* in 2016. Reading it needs browser cookies, which Google revokes when they are used from a data centre.
- The caption fetcher (yt-dlp) is downloaded on first use. YouTube may challenge data-centre addresses ("confirm you're not a bot"); the video then stays `todo`.
- The OAuth consent screen MUST be *In production*. In *Testing* the refresh token expires after 7 days.
