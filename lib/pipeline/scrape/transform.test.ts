import { describe, expect, test } from "vitest";
import { ScrapedItemSchema } from "../../domain/item";
import type { Source } from "../../domain/source";
import { SourceSchema } from "../../domain/source";
import type { TransformInput } from "./transform";
import { transformPost } from "./transform";

const DATE = "2026-08-29";

/** Parsed rather than written out, so the counter defaults of §2.1 L107–111 fill in. */
const makeSource = (overrides: Partial<Source> = {}): Source =>
  SourceSchema.parse({
    id: "yigal_levin",
    status: "ok",
    tgChannel: "telegator_news",
    category: "geopolitics",
    tags: "war,politics",
    ...overrides,
  });

const makePost = (overrides: Partial<TransformInput> = {}): TransformInput => ({
  id: "12345",
  body: "Explosions reported in [the capital](#1)",
  links: [{ id: 1, href: "https://example.test/a" }],
  ...overrides,
});

describe("transformPost — id (§3.1 L212)", () => {
  test("builds the composite `{sourceId}/{messageId}`", () => {
    const item = transformPost(makePost({ id: "999" }), makeSource({ id: "nexta_live" }), DATE);
    expect(item.id).toBe("nexta_live/999");
  });

  test("rejects a message id that is not digits, per ItemIdSchema (§2.4 L173)", () => {
    expect(() => transformPost(makePost({ id: "not-a-number" }), makeSource(), DATE)).toThrow();
  });
});

describe("transformPost — teaser stripping (§3.1 L212)", () => {
  test("removes every occurrence of the teaser, not just the first", () => {
    const post = makePost({ body: "SUB Explosions SUB reported SUB" });
    expect(transformPost(post, makeSource({ teaser: "SUB" }), DATE).body).toBe(
      "Explosions  reported",
    );
  });

  test("is case-sensitive: a differently-cased occurrence survives", () => {
    const post = makePost({ body: "Subscribe now, subscribe later" });
    expect(transformPost(post, makeSource({ teaser: "subscribe" }), DATE).body).toBe(
      "Subscribe now,  later",
    );
  });

  test("leaves the body untouched when the source has no teaser", () => {
    const post = makePost({ body: "  Explosions reported  " });
    expect(transformPost(post, makeSource(), DATE).body).toBe("  Explosions reported  ");
  });

  test("an empty-string teaser strips nothing", () => {
    const post = makePost({ body: "Explosions reported" });
    expect(transformPost(post, makeSource({ teaser: "" }), DATE).body).toBe("Explosions reported");
  });

  /**
   * The parse step of §3.1 L203 has already replaced `<a href="X">Y</a>` with
   * `[Y](#N)`, so an operator teaser written as raw HTML cannot match.
   */
  test("matches the tokenised body, so a teaser containing a link does not match", () => {
    const post = makePost({ body: "Explosions reported [Subscribe](#1)" });
    const source = makeSource({ teaser: '<a href="https://t.me/x">Subscribe</a>' });
    expect(transformPost(post, source, DATE).body).toBe("Explosions reported [Subscribe](#1)");
  });

  test("re-trims the whitespace the removal leaves behind", () => {
    const post = makePost({ body: "Explosions reported\n\nSubscribe!" });
    expect(transformPost(post, makeSource({ teaser: "Subscribe!" }), DATE).body).toBe(
      "Explosions reported",
    );
  });
});

describe("transformPost — stamped source fields (§3.1 L212)", () => {
  test("copies tgChannel, category and tags from the source", () => {
    const item = transformPost(makePost(), makeSource(), DATE);
    expect(item.tgChannel).toBe("telegator_news");
    expect(item.category).toBe("geopolitics");
    expect(item.tags).toBe("war,politics");
  });

  test("leaves them absent when the source does not curate them", () => {
    const source = makeSource({ tgChannel: undefined, category: undefined, tags: undefined });
    const item = transformPost(makePost(), source, DATE);
    expect(item.tgChannel).toBeUndefined();
    expect(item.category).toBeUndefined();
    expect(item.tags).toBeUndefined();
  });

  /** §2.2 L127 — the scrape date, supplied by the caller so a run shares one key. */
  test("stamps the date passed in, not a clock reading", () => {
    expect(transformPost(makePost(), makeSource(), "2020-01-02").date).toBe("2020-01-02");
  });
});

describe("transformPost — kind (§2.2 L130, §3.1 L212)", () => {
  test("`post` for an ordinary post", () => {
    expect(transformPost(makePost(), makeSource(), DATE).kind).toBe("post");
  });

  test("`forward` when forwardedFrom is set", () => {
    const post = makePost({ forwardedFrom: "nexta_live" });
    expect(transformPost(post, makeSource(), DATE).kind).toBe("forward");
  });

  test("`empty` for a blank body", () => {
    expect(transformPost(makePost({ body: "" }), makeSource(), DATE).kind).toBe("empty");
  });

  test("`empty` for a whitespace-only body", () => {
    expect(transformPost(makePost({ body: " \n\t " }), makeSource(), DATE).kind).toBe("empty");
  });

  test("`empty` when the teaser was the whole body", () => {
    const post = makePost({ body: "Subscribe!" });
    expect(transformPost(post, makeSource({ teaser: "Subscribe!" }), DATE).kind).toBe("empty");
  });

  /** §3.1 L212 names `forward` before `empty`; the order is normative. */
  test("`forward` wins over `empty` for a forwarded post with a blank body", () => {
    const post = makePost({ body: "   ", forwardedFrom: "nexta_live" });
    expect(transformPost(post, makeSource(), DATE).kind).toBe("forward");
  });

  test("an empty-string forwardedFrom is not a forward", () => {
    const post = makePost({ forwardedFrom: "" });
    expect(transformPost(post, makeSource(), DATE).kind).toBe("post");
  });
});

describe("transformPost — carried-through fields (§2.2 L120–130)", () => {
  test("carries links and image unchanged", () => {
    const links = [
      { id: 1, href: "https://example.test/a" },
      { id: 2, href: "https://example.test/b" },
    ];
    const post = makePost({ links, image: "https://cdn.example.test/p.jpg" });
    const item = transformPost(post, makeSource(), DATE);
    expect(item.links).toEqual(links);
    expect(item.image).toBe("https://cdn.example.test/p.jpg");
  });

  test("carries forwardedFrom through", () => {
    const post = makePost({ forwardedFrom: "nexta_live" });
    expect(transformPost(post, makeSource(), DATE).forwardedFrom).toBe("nexta_live");
  });

  test("a post with no links or image yields an empty links array and no image", () => {
    const item = transformPost(makePost({ links: [] }), makeSource(), DATE);
    expect(item.links).toEqual([]);
    expect(item.image).toBeUndefined();
  });
});

describe("transformPost — schema conformance", () => {
  test("the result parses against ScrapedItemSchema", () => {
    const post = makePost({ image: "https://cdn.example.test/p.jpg", forwardedFrom: "nexta_live" });
    const item = transformPost(post, makeSource({ teaser: "Subscribe!" }), DATE);
    expect(() => ScrapedItemSchema.parse(item)).not.toThrow();
  });

  test("rejects a date that is not a YYYY-MM-DD key (§2.2 L127)", () => {
    expect(() => transformPost(makePost(), makeSource(), "29-08-2026")).toThrow();
  });
});
