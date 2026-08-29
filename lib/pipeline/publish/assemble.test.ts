import { describe, expect, test } from "vitest";
import { SUMMARY_MAX_LENGTH } from "../../domain/item";
import type { MemberBlock, Message } from "../../domain/message";
import { MEMBER_RENDER_LIMIT, MemberBlockSchema, MessageSchema } from "../../domain/message";
import { TELEGRAM_MESSAGE_LIMIT } from "../../telegram/ports";
import { assembleMessage, buildHeader, PHOTO_SUPPRESSION_LIMIT } from "./assemble";
import { buildHashtagLine } from "./hashtags";

/**
 * Fixtures go through the schemas rather than object literals: the house rule
 * bans type assertions, and parsing proves each fixture is a record the
 * aggregate stage (§3.3) could actually have written.
 */
function member(fields: Record<string, unknown>): MemberBlock {
  return MemberBlockSchema.parse({ summary: "s", channel: "chan", ts: 0, ...fields });
}

interface MessageOverrides {
  readonly members?: Record<string, MemberBlock>;
  readonly date?: string;
  readonly ts?: number;
  readonly title?: string;
  readonly category?: string;
  readonly country?: string;
  readonly location?: string;
  readonly peoples?: string;
  readonly tags?: string;
  readonly image?: string;
  readonly tgId?: string;
  readonly tgChannel?: string;
}

const DEFAULT_DATE = "2026-08-29";
const DEFAULT_TS = 1756400000000;

function message(overrides: MessageOverrides = {}): Message {
  const members = overrides.members ?? { "chan/1": member({}) };

  return MessageSchema.parse({
    id: "chan/1",
    status: "topublish",
    date: DEFAULT_DATE,
    ts: DEFAULT_TS,
    ...overrides,
    members,
    memberCount: Object.keys(members).length,
  });
}

/** `fillers` members at the summary cap, plus one whose summary is the tuning knob. */
function paddedMembers(fillers: number, pad: number): Record<string, MemberBlock> {
  const members: Record<string, MemberBlock> = {};

  for (let i = 0; i < fillers; i += 1) {
    members[`chan/${i + 1}`] = member({ summary: "a".repeat(SUMMARY_MAX_LENGTH), ts: i });
  }
  members[`chan/${fillers + 1}`] = member({ summary: "a".repeat(pad), ts: fillers });

  return members;
}

/**
 * Builds a message whose *assembled* text is exactly `target` characters, so the
 * AC-4.2 boundary can be probed on both sides. The length is measured by
 * actually assembling, never predicted, so header and hashtag overheads cannot
 * drift out of sync with the implementation.
 */
function messageOfTextLength(target: number, overrides: MessageOverrides = {}): Message {
  for (let fillers = 0; fillers < MEMBER_RENDER_LIMIT; fillers += 1) {
    const base = assembleMessage(message({ ...overrides, members: paddedMembers(fillers, 0) }));
    const pad = target - base.text.length;

    if (pad >= 0 && pad <= SUMMARY_MAX_LENGTH) {
      const candidate = message({ ...overrides, members: paddedMembers(fillers, pad) });
      if (assembleMessage(candidate).text.length === target) return candidate;
    }
  }

  throw new Error(`no fixture assembles to exactly ${target} characters`);
}

function memberBlockCount(text: string): number {
  return text.split("🔘").length - 1;
}

describe("buildHeader", () => {
  test("§3.4 L326 — <b>⚡️</b> <i>{date}</i> <b>{COUNTRY, location, category}</b>", () => {
    const header = buildHeader({
      date: DEFAULT_DATE,
      country: "Belarus",
      location: "Minsk",
      category: "politics",
    });

    expect(header).toBe("<b>⚡️</b> <i>2026-08-29</i> <b>BELARUS, Minsk, politics</b>");
  });

  test("§3.4 L333 — country is uppercased, location and category are not", () => {
    const header = buildHeader({
      date: DEFAULT_DATE,
      country: "belarus",
      location: "Minsk",
      category: "politics",
    });

    expect(header).toContain("<b>BELARUS, Minsk, politics</b>");
  });

  test("§3.4 L333 — an absent part is omitted, and no separator is left behind", () => {
    expect(buildHeader({ date: DEFAULT_DATE, country: "Belarus", category: "politics" })).toBe(
      "<b>⚡️</b> <i>2026-08-29</i> <b>BELARUS, politics</b>",
    );
    expect(buildHeader({ date: DEFAULT_DATE, location: "Minsk" })).toBe(
      "<b>⚡️</b> <i>2026-08-29</i> <b>Minsk</b>",
    );
  });

  test("an empty or whitespace-only part counts as absent (§3.4 L333, 'non-empty')", () => {
    expect(buildHeader({ date: DEFAULT_DATE, country: "", location: "   ", category: "war" })).toBe(
      "<b>⚡️</b> <i>2026-08-29</i> <b>war</b>",
    );
  });

  test("with no location parts at all the bold group is dropped, not left empty", () => {
    expect(buildHeader({ date: DEFAULT_DATE })).toBe("<b>⚡️</b> <i>2026-08-29</i>");
  });

  test("escapes header values so parse_mode html cannot break on model output", () => {
    expect(buildHeader({ date: DEFAULT_DATE, location: "R&D <lab>" })).toContain(
      "<b>R&amp;D &lt;lab&gt;</b>",
    );
  });
});

describe("assembleMessage — layout", () => {
  test("§3.4 L326–331 — header, one blank line, then the member blocks", () => {
    const assembled = assembleMessage(
      message({
        country: "Belarus",
        location: "Minsk",
        category: "politics",
        members: {
          "chan/1": member({ summary: "first", ts: 1 }),
          "chan/2": member({ summary: "second", ts: 2 }),
        },
      }),
    );
    const lines = assembled.text.split("\n");

    expect(lines[0]).toBe("<b>⚡️</b> <i>2026-08-29</i> <b>BELARUS, Minsk, politics</b>");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe('🔘 first - <a href="https://t.me/chan/1">@chan</a>');
    expect(lines[3]).toBe('🔘 second - <a href="https://t.me/chan/2">@chan</a>');
  });

  test("R12 — the hashtag line is appended after the members, behind a blank line", () => {
    const record = message({ category: "politics", tags: "minsk" });
    const line = buildHashtagLine({
      category: "politics",
      tags: "minsk",
      date: DEFAULT_DATE,
      ts: DEFAULT_TS,
    });

    expect(line).not.toBe("");
    expect(assembleMessage(record).text.endsWith(`\n\n${line}`)).toBe(true);
  });
});

describe("assembleMessage — send mode", () => {
  test("AC-4.2 — a message whose text exceeds 1012 characters is sent without a photo", () => {
    const image = "https://e.by/p.jpg";
    const overLimit = messageOfTextLength(1013, { image });

    const assembled = assembleMessage(overLimit);

    expect(assembled.text.length).toBe(1013);
    expect(assembled.method).toBe("sendMessage");
    expect(assembled.photo).toBeUndefined();
  });

  test("AC-4.2 — at exactly 1012 characters the photo survives (the other side)", () => {
    const image = "https://e.by/p.jpg";
    const atLimit = messageOfTextLength(1012, { image });

    const assembled = assembleMessage(atLimit);

    expect(assembled.text.length).toBe(1012);
    expect(assembled.method).toBe("sendPhoto");
    expect(assembled.photo).toBe(image);
  });

  test("R13 — the suppression threshold is 1012, not the 1024 caption limit", () => {
    expect(PHOTO_SUPPRESSION_LIMIT).toBe(1012);
  });

  test("§3.4 L339 — no tgId and no image is a plain sendMessage", () => {
    const assembled = assembleMessage(message());

    expect(assembled.method).toBe("sendMessage");
    expect(assembled.photo).toBeUndefined();
  });

  test("AC-4.1 / §3.4 L340 — a tgId edits, and never re-sends the photo", () => {
    const assembled = assembleMessage(message({ tgId: "4711", image: "https://e.by/p.jpg" }));

    expect(assembled.method).toBe("editMessageText");
    expect(assembled.photo).toBeUndefined();
  });

  test("§4.2 L379 — chatId is the target channel with a leading @", () => {
    expect(assembleMessage(message()).chatId).toBe("@telegator_news");
    expect(assembleMessage(message({ tgChannel: "other_news" })).chatId).toBe("@other_news");
    expect(assembleMessage(message({ tgChannel: "@already" })).chatId).toBe("@already");
  });

  test("§3.4 L342 — link preview is disabled when the message has a title", () => {
    expect(assembleMessage(message({ title: "Blast in Minsk" })).disableWebPagePreview).toBe(true);
  });

  test("§3.4 L342 — link preview is disabled when the message has an image", () => {
    expect(assembleMessage(message({ image: "https://e.by/p.jpg" })).disableWebPagePreview).toBe(
      true,
    );
  });

  test("§3.4 L342 — link preview stays enabled with neither title nor image", () => {
    expect(assembleMessage(message()).disableWebPagePreview).toBe(false);
  });
});

describe("assembleMessage — overflow (recorded rule, §3.4 L382 gives no truncation)", () => {
  /** 80 distinct tokens, enough hashtag line to push a full message over 4096. */
  const MANY_TAGS = Array.from({ length: 80 }, (_, i) => `overflowtag${i}`).join(",");

  function fullMembers(): Record<string, MemberBlock> {
    const members: Record<string, MemberBlock> = {};
    for (let i = 0; i < MEMBER_RENDER_LIMIT; i += 1) {
      members[`chan/${i + 1}`] = member({ summary: "a".repeat(SUMMARY_MAX_LENGTH), ts: i });
    }
    return members;
  }

  test("hashtags are dropped first, and every member block survives", () => {
    const record = message({ tags: MANY_TAGS, members: fullMembers() });
    const line = buildHashtagLine({ tags: MANY_TAGS, date: DEFAULT_DATE, ts: DEFAULT_TS });
    const assembled = assembleMessage(record);

    // Precondition: the message only overflows *because* R12 appends the line.
    expect(assembled.text.length + line.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);

    expect(assembled.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(assembled.text).not.toContain("#overflowtag0");
    expect(memberBlockCount(assembled.text)).toBe(MEMBER_RENDER_LIMIT);
  });

  test("members are reduced only once dropping the hashtags is not enough", () => {
    // A long `location` inflates the header past what member trimming alone
    // could have caused, so overflow survives the hashtag drop.
    const record = message({
      location: "l".repeat(1500),
      tags: MANY_TAGS,
      members: fullMembers(),
    });
    const assembled = assembleMessage(record);

    expect(assembled.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(assembled.text).not.toContain("#overflowtag0");
    expect(memberBlockCount(assembled.text)).toBeGreaterThan(0);
    expect(memberBlockCount(assembled.text)).toBeLessThan(MEMBER_RENDER_LIMIT);
  });

  test("a message that already fits is left exactly as assembled", () => {
    const record = message({ category: "politics", members: fullMembers() });
    const line = buildHashtagLine({ category: "politics", date: DEFAULT_DATE, ts: DEFAULT_TS });
    const assembled = assembleMessage(record);

    expect(assembled.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(assembled.text.endsWith(`\n\n${line}`)).toBe(true);
    expect(memberBlockCount(assembled.text)).toBe(MEMBER_RENDER_LIMIT);
  });
});
