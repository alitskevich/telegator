import { describe, expect, test } from "vitest";
import { parseJson3, pickCaptionTrack, renderTranscript, timestamp } from "./captions";

describe("pickCaptionTrack", () => {
  test("prefers the spoken track over an auto-translation", () => {
    const auto = ["en", "nl", "ru", "ru-orig"];
    expect(pickCaptionTrack({ auto, langPref: "en", videoLanguage: "ru" })).toEqual({
      lang: "ru-orig",
      kind: "auto",
    });
    expect(pickCaptionTrack({ auto: ["en-orig", "en", "ru"], langPref: "en" })).toEqual({
      lang: "en-orig",
      kind: "auto",
    });
    expect(pickCaptionTrack({ manual: ["en"], auto, langPref: "en" })).toEqual({
      lang: "en",
      kind: "manual",
    });
    expect(pickCaptionTrack({ auto: ["en", "de"], langPref: "de" })).toEqual({
      lang: "de",
      kind: "auto",
    });
  });

  test("picks the wanted language among dubbed audio tracks", () => {
    const auto = ["ar-orig", "ar", "en", "en-orig", "ru-orig", "nl"];
    const en = { lang: "en-orig", kind: "auto" };
    expect(pickCaptionTrack({ auto, langPref: "en", videoLanguage: "en-US" })).toEqual(en);
    expect(pickCaptionTrack({ auto, langPref: "nl", videoLanguage: "en-US" })).toEqual(en);
    expect(pickCaptionTrack({ auto, langPref: "ru" })).toEqual({ lang: "ru-orig", kind: "auto" });
  });

  test("is null without any track", () => {
    expect(pickCaptionTrack({ langPref: "en" })).toBeNull();
  });
});

describe("parseJson3", () => {
  test("merges caption lines into ~25 s chunks and drops padding events", () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: "  world" }] },
        { tStartMs: 1000, segs: [{ utf8: "\n" }] },
        { tStartMs: 10_000, segs: [{ utf8: "again" }] },
        { tStartMs: 30_500, segs: [{ utf8: "later" }] },
      ],
    });
    expect(parseJson3(raw)).toEqual([
      { start: 0, text: "Hello world again" },
      { start: 30, text: "later" },
    ]);
  });
});

describe("renderTranscript", () => {
  test("links every bullet to its moment in the video", () => {
    const video = { id: "M2exXwKXN7M", title: "Talk", channel: "Chan", duration: 3725 };
    expect(renderTranscript(video, "en-orig", [{ start: 75, text: "Hi." }])).toBe(
      "# Talk\n\nhttps://www.youtube.com/watch?v=M2exXwKXN7M\n\n" +
        "> Chan · 1:02:05 · captions: en-orig\n\n" +
        "- [01:15](https://www.youtube.com/watch?v=M2exXwKXN7M&t=75s) Hi.\n",
    );
    expect(timestamp(59)).toBe("00:59");
  });
});
