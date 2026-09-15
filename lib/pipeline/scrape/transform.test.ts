import { describe, expect, test } from "vitest";
import { ScrapedItemSchema } from "../../domain/item";
import type { Source } from "../../domain/source";
import { SourceSchema } from "../../domain/source";
import type { TransformInput } from "./transform";
import { MAX_POST_AGE_MS, transformPost } from "./transform";

const DATE = "2026-08-29";

/** The run's wall clock. Every post below is dated relative to it. */
const NOW = Date.parse("2026-08-29T09:15:00+00:00");

/** Parsed rather than written out, so the counter defaults of §2.1 L115–119 fill in. */
const makeSource = (overrides: Partial<Source> = {}): Source =>
  SourceSchema.parse({
    id: "yigal_levin",
    status: "ok",
    target: "telegator_news",
    category: "geopolitics",
    tags: "war,politics",
    ...overrides,
  });

const makePost = (overrides: Partial<TransformInput> = {}): TransformInput => ({
  id: "12345",
  body: "Explosions reported in [the capital](#1)",
  links: [{ id: 1, href: "https://example.test/a" }],
  // Fresh by default, so a case about something else is never about age.
  postedAt: new Date(NOW).toISOString(),
  ...overrides,
});

/** A post published `ms` before the run. */
const agedPost = (ms: number, overrides: Partial<TransformInput> = {}): TransformInput =>
  makePost({ postedAt: new Date(NOW - ms).toISOString(), ...overrides });

describe("transformPost — id (§3.1 L225)", () => {
  test("builds the composite `{sourceId}/{messageId}`", () => {
    const item = transformPost(
      makePost({ id: "999" }),
      makeSource({ id: "nexta_live" }),
      DATE,
      NOW,
    );
    expect(item.id).toBe("nexta_live/999");
  });

  test("rejects a message id that is not digits, per ItemIdSchema (§2.4 L185)", () => {
    expect(() =>
      transformPost(makePost({ id: "not-a-number" }), makeSource(), DATE, NOW),
    ).toThrow();
  });
});

describe("transformPost — teaser stripping (§3.1 L225)", () => {
  test("removes every occurrence of the teaser, not just the first", () => {
    const post = makePost({ body: "SUB Explosions SUB reported SUB" });
    expect(transformPost(post, makeSource({ teaser: "SUB" }), DATE, NOW).body).toBe(
      "Explosions  reported",
    );
  });

  test("is case-sensitive: a differently-cased occurrence survives", () => {
    const post = makePost({ body: "Subscribe now, subscribe later" });
    expect(transformPost(post, makeSource({ teaser: "subscribe" }), DATE, NOW).body).toBe(
      "Subscribe now,  later",
    );
  });

  test("leaves the body untouched when the source has no teaser", () => {
    const post = makePost({ body: "  Explosions reported  " });
    expect(transformPost(post, makeSource(), DATE, NOW).body).toBe("  Explosions reported  ");
  });

  test("an empty-string teaser strips nothing", () => {
    const post = makePost({ body: "Explosions reported" });
    expect(transformPost(post, makeSource({ teaser: "" }), DATE, NOW).body).toBe(
      "Explosions reported",
    );
  });

  /**
   * The parse step of §3.1 L215 has already replaced `<a href="X">Y</a>` with
   * `[Y](#N)`, so an operator teaser written as raw HTML cannot match.
   */
  test("matches the tokenised body, so a teaser containing a link does not match", () => {
    const post = makePost({ body: "Explosions reported [Subscribe](#1)" });
    const source = makeSource({ teaser: '<a href="https://t.me/x">Subscribe</a>' });
    expect(transformPost(post, source, DATE, NOW).body).toBe("Explosions reported [Subscribe](#1)");
  });

  test("re-trims the whitespace the removal leaves behind", () => {
    const post = makePost({ body: "Explosions reported\n\nSubscribe!" });
    expect(transformPost(post, makeSource({ teaser: "Subscribe!" }), DATE, NOW).body).toBe(
      "Explosions reported",
    );
  });
});

describe("transformPost — stamped source fields (§3.1 L225)", () => {
  test("MT-4: copies target, category and tags from the source", () => {
    const item = transformPost(makePost(), makeSource({ target: "a, @b" }), DATE, NOW);
    expect(item.target).toBe("a, @b");
    expect(item.category).toBe("geopolitics");
    expect(item.tags).toBe("war,politics");
  });

  test("MT-4: leaves them absent when the source does not curate them", () => {
    const source = makeSource({ target: undefined, category: undefined, tags: undefined });
    const item = transformPost(makePost(), source, DATE, NOW);
    expect(item.target).toBeUndefined();
    expect(item.category).toBeUndefined();
    expect(item.tags).toBeUndefined();
  });

  /** §2.2 L137 — the scrape date, supplied by the caller so a run shares one key. */
  test("stamps the date passed in, not a clock reading", () => {
    expect(transformPost(makePost(), makeSource(), "2020-01-02", NOW).date).toBe("2020-01-02");
  });
});

describe("transformPost — kind (§2.2 L140, §3.1 L225)", () => {
  test("`post` for an ordinary post", () => {
    expect(transformPost(makePost(), makeSource(), DATE, NOW).kind).toBe("post");
  });

  test("`forward` when forwardedFrom is set", () => {
    const post = makePost({ forwardedFrom: "nexta_live" });
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("forward");
  });

  test("`empty` for a blank body", () => {
    expect(transformPost(makePost({ body: "" }), makeSource(), DATE, NOW).kind).toBe("empty");
  });

  test("`empty` for a whitespace-only body", () => {
    expect(transformPost(makePost({ body: " \n\t " }), makeSource(), DATE, NOW).kind).toBe("empty");
  });

  test("`empty` when the teaser was the whole body", () => {
    const post = makePost({ body: "Subscribe!" });
    expect(transformPost(post, makeSource({ teaser: "Subscribe!" }), DATE, NOW).kind).toBe("empty");
  });

  /** §3.1 L225 names `forward` before `empty`; the order is normative. */
  test("`forward` wins over `empty` for a forwarded post with a blank body", () => {
    const post = makePost({ body: "   ", forwardedFrom: "nexta_live" });
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("forward");
  });

  test("an empty-string forwardedFrom is not a forward", () => {
    const post = makePost({ forwardedFrom: "" });
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("post");
  });
});

describe("transformPost — carried-through fields (§2.2 L130–140)", () => {
  test("carries links and image unchanged", () => {
    const links = [
      { id: 1, href: "https://example.test/a" },
      { id: 2, href: "https://example.test/b" },
    ];
    const post = makePost({ links, image: "https://cdn.example.test/p.jpg" });
    const item = transformPost(post, makeSource(), DATE, NOW);
    expect(item.links).toEqual(links);
    expect(item.image).toBe("https://cdn.example.test/p.jpg");
  });

  test("carries forwardedFrom through", () => {
    const post = makePost({ forwardedFrom: "nexta_live" });
    expect(transformPost(post, makeSource(), DATE, NOW).forwardedFrom).toBe("nexta_live");
  });

  test("a post with no links or image yields an empty links array and no image", () => {
    const item = transformPost(makePost({ links: [] }), makeSource(), DATE, NOW);
    expect(item.links).toEqual([]);
    expect(item.image).toBeUndefined();
  });
});

describe("transformPost — schema conformance", () => {
  test("the result parses against ScrapedItemSchema", () => {
    const post = makePost({ image: "https://cdn.example.test/p.jpg", forwardedFrom: "nexta_live" });
    const item = transformPost(post, makeSource({ teaser: "Subscribe!" }), DATE, NOW);
    expect(() => ScrapedItemSchema.parse(item)).not.toThrow();
  });

  test("rejects a date that is not a YYYY-MM-DD key (§2.2 L137)", () => {
    expect(() => transformPost(makePost(), makeSource(), "29-08-2026", NOW)).toThrow();
  });
});

describe("transformPost — freshness (§3.1 L227)", () => {
  test("a post published just now is a `post`", () => {
    expect(transformPost(agedPost(0), makeSource(), DATE, NOW).kind).toBe("post");
  });

  test("a post exactly at the cutoff is still fresh — the age must exceed it", () => {
    expect(transformPost(agedPost(MAX_POST_AGE_MS), makeSource(), DATE, NOW).kind).toBe("post");
  });

  test("a post one millisecond past the cutoff is `obsolete`", () => {
    const post = agedPost(MAX_POST_AGE_MS + 1);
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("obsolete");
  });

  test("the cutoff is three days", () => {
    expect(MAX_POST_AGE_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  test("age is tested before `forward`, so a stale forward reads as obsolete", () => {
    const post = agedPost(MAX_POST_AGE_MS + 1, { forwardedFrom: "origin_channel" });
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("obsolete");
  });

  test("a post with no time on the page is obsolete, not fresh", () => {
    const post = makePost({ postedAt: undefined });
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("obsolete");
  });

  test("an unparseable time is obsolete", () => {
    const post = makePost({ postedAt: "yesterday-ish" });
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("obsolete");
  });

  test("a post dated in the future is fresh, never obsolete", () => {
    const post = agedPost(-MAX_POST_AGE_MS);
    expect(transformPost(post, makeSource(), DATE, NOW).kind).toBe("post");
  });
});
