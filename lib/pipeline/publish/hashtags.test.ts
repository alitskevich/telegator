import { describe, expect, test } from "vitest";
import { buildHashtagLine, toHashtag } from "./hashtags";

/**
 * A fixed instant, so every expectation below can name the exact `date_`/`ts_`
 * tags. `date` is already a `YYYY-MM-DD` key by the time publish runs (§2.3
 * L148), so it is interpolated rather than derived here.
 */
const DATE = "2026-08-29";
const TS = 1756468800000;
const DATE_TS = "#date_2026_08_29 #ts_1756468800000";

/** The two tags §3.4 L335 always contributes, on an otherwise empty source. */
const empty = { date: DATE, ts: TS };

describe("toHashtag", () => {
  test("prefixes with #", () => {
    expect(toHashtag("war")).toBe("#war");
  });

  test("maps spaces to underscores", () => {
    expect(toHashtag("real estate")).toBe("#real_estate");
  });

  test("maps hyphens to underscores", () => {
    expect(toHashtag("real-estate")).toBe("#real_estate");
  });

  test("lowercases", () => {
    expect(toHashtag("NATO Summit")).toBe("#nato_summit");
  });

  // §3.4 L335 lists exactly these eight characters as removed.
  const removed: ReadonlyArray<readonly [string, string, string]> = [
    ["period", "u.s.a", "#usa"],
    ["comma", "a,b", "#ab"],
    ["at sign", "@channel", "#channel"],
    ["exclamation mark", "wow!", "#wow"],
    ["apostrophe", "don't", "#dont"],
    ["double quote", 'say "hi"', "#say_hi"],
    ["opening parenthesis", "(eu", "#eu"],
    ["closing parenthesis", "eu)", "#eu"],
  ];

  for (const [name, input, expected] of removed) {
    test(`removes the ${name}`, () => {
      expect(toHashtag(input)).toBe(expected);
    });
  }

  /**
   * The underscore is not in the removal set, which is what keeps the
   * `date_`/`ts_` tokens of §3.4 L335 readable after normalisation.
   */
  test("preserves underscores", () => {
    expect(toHashtag("date_2026-08-29")).toBe("#date_2026_08_29");
  });
});

describe("buildHashtagLine", () => {
  test("takes tags from category", () => {
    expect(buildHashtagLine({ ...empty, category: "geopolitics" })).toBe(`#geopolitics ${DATE_TS}`);
  });

  test("takes tags from location", () => {
    expect(buildHashtagLine({ ...empty, location: "Minsk" })).toBe(`#minsk ${DATE_TS}`);
  });

  test("takes tags from peoples", () => {
    expect(buildHashtagLine({ ...empty, peoples: "Lukashenko" })).toBe(`#lukashenko ${DATE_TS}`);
  });

  test("takes tags from tags", () => {
    expect(buildHashtagLine({ ...empty, tags: "war" })).toBe(`#war ${DATE_TS}`);
  });

  test("splits every source field on commas", () => {
    expect(buildHashtagLine({ ...empty, tags: "war, politics ,sanctions" })).toBe(
      `#war #politics #sanctions ${DATE_TS}`,
    );
  });

  test("emits the four source fields in the order §3.4 L335 lists them", () => {
    const line = buildHashtagLine({
      ...empty,
      category: "geopolitics",
      location: "Minsk",
      peoples: "Lukashenko",
      tags: "war",
    });
    expect(line).toBe(`#geopolitics #minsk #lukashenko #war ${DATE_TS}`);
  });

  test("excludes a title word of exactly four characters and includes one of five", () => {
    const line = buildHashtagLine({ ...empty, title: "four fives" });
    expect(line).toBe(`#fives ${DATE_TS}`);
    expect(line).not.toContain("#four");
  });

  test("includes every title word longer than four characters", () => {
    expect(buildHashtagLine({ ...empty, title: "Explosions over the capital city" })).toBe(
      `#explosions #capital ${DATE_TS}`,
    );
  });

  test("drops none, null and their uppercase spellings", () => {
    expect(
      buildHashtagLine({ ...empty, category: "none", location: "NULL", peoples: "None,NONE" }),
    ).toBe(DATE_TS);
  });

  test("drops empty and whitespace-only tokens", () => {
    expect(buildHashtagLine({ ...empty, tags: " , ,,war,   " })).toBe(`#war ${DATE_TS}`);
  });

  test("drops a token that normalises to nothing", () => {
    expect(buildHashtagLine({ ...empty, tags: "(...)" })).toBe(DATE_TS);
  });

  test("deduplicates across source fields", () => {
    expect(buildHashtagLine({ ...empty, category: "war", tags: "war,peace,war" })).toBe(
      `#war #peace ${DATE_TS}`,
    );
  });

  test("deduplicates after normalisation, so one hashtag never repeats", () => {
    expect(buildHashtagLine({ ...empty, category: "real-estate", tags: "Real Estate" })).toBe(
      `#real_estate ${DATE_TS}`,
    );
  });

  test("deduplicates a title word against a tag", () => {
    expect(
      buildHashtagLine({ ...empty, tags: "sanctions", title: "New sanctions announced" }),
    ).toBe(`#sanctions #announced ${DATE_TS}`);
  });

  test("keeps first-seen order when deduplicating", () => {
    expect(buildHashtagLine({ ...empty, category: "war", location: "Minsk", tags: "war" })).toBe(
      `#war #minsk ${DATE_TS}`,
    );
  });

  test("emits the date token as date_ plus the date key", () => {
    expect(buildHashtagLine({ date: "2024-01-02", ts: TS })).toContain("#date_2024_01_02");
  });

  test("emits the ts token as ts_ plus the epoch milliseconds", () => {
    expect(buildHashtagLine({ date: DATE, ts: 17 })).toContain("#ts_17");
  });

  test("yields only the date and ts tags when every field is absent", () => {
    expect(buildHashtagLine(empty)).toBe(DATE_TS);
  });

  test("yields only the date and ts tags when every field is empty", () => {
    expect(
      buildHashtagLine({ ...empty, category: "", location: "", peoples: "", tags: "", title: "" }),
    ).toBe(DATE_TS);
  });

  test("starts every token with #", () => {
    const line = buildHashtagLine({
      ...empty,
      category: "geopolitics",
      location: "Minsk",
      peoples: "Lukashenko",
      tags: "war",
      title: "Explosions reported",
    });
    for (const token of line.split(" ")) {
      expect(token.startsWith("#")).toBe(true);
    }
  });

  test("joins with a single space and neither leads nor trails with one", () => {
    const line = buildHashtagLine({ ...empty, category: "a b", tags: "war,peace" });
    expect(line).toBe(line.trim());
    expect(line).not.toContain("  ");
  });

  /**
   * AC-3.7 (L306) makes byte-identical replay a property of the pipeline, and a
   * hashtag line that reordered itself between runs would break the edit path
   * of §3.4 L339 by rewriting a message that had not changed.
   */
  test("is deterministic across repeated calls", () => {
    const source = {
      ...empty,
      category: "geopolitics",
      location: "Minsk, Belarus",
      peoples: "Lukashenko",
      tags: "war,politics",
      title: "Explosions reported overnight",
    };
    expect(buildHashtagLine(source)).toBe(buildHashtagLine(source));
  });
});

describe("title words", () => {
  /**
   * A hyphenated title word is one word, and stays one hashtag — the hyphen is
   * normalised to `_` by §3.4 L335's mapping, it does not split the word.
   */
  test("treats a hyphenated word as a single word", () => {
    expect(buildHashtagLine({ ...empty, title: "The real-estate market" })).toBe(
      `#real_estate #market ${DATE_TS}`,
    );
  });

  test("ignores runs of whitespace between words", () => {
    expect(buildHashtagLine({ ...empty, title: "  Explosions   reported  " })).toBe(
      `#explosions #reported ${DATE_TS}`,
    );
  });
});
