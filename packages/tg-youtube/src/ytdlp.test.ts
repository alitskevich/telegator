import { describe, expect, test } from "vitest";
import { unavailableReason } from "./ytdlp";

const ID = "M2exXwKXN7M";

describe("unavailableReason", () => {
  test("reads yt-dlp's reason for a video nobody can watch", () => {
    expect(
      unavailableReason(
        `yt-dlp exited 1\nERROR: [youtube] ${ID}: Video unavailable. This video has been removed by the uploader`,
      ),
    ).toBe("Video unavailable. This video has been removed by the uploader");
    expect(unavailableReason(`ERROR: [youtube] ${ID}: This video is unavailable`)).toBe(
      "This video is unavailable",
    );
    expect(
      unavailableReason(
        `ERROR: [youtube] ${ID}: Private video. Sign in if you've been granted access to this video`,
      ),
    ).toBe("Private video. Sign in if you've been granted access to this video");
  });

  test("is null for an error worth a retry", () => {
    expect(unavailableReason("yt-dlp exited 1\nERROR: HTTP Error 429: Too Many Requests")).toBe(
      null,
    );
    expect(unavailableReason(`ERROR: [youtube] ${ID}: Sign in to confirm you're not a bot`)).toBe(
      null,
    );
  });
});
