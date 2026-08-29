import { describe, expect, test } from "vitest";
import type { MemberBlock } from "../../domain/message";
import { MEMBER_RENDER_LIMIT, MemberBlockSchema } from "../../domain/message";
import { renderMember, renderMembers } from "./render";

/**
 * Built through `MemberBlockSchema.parse` rather than an object literal: the
 * house rule bans type assertions, and parsing also proves each fixture is a
 * block the aggregate stage could actually have written (§2.3 L156–163).
 */
function member(fields: Record<string, unknown>): MemberBlock {
  return MemberBlockSchema.parse({ summary: "s", channel: "chan", ts: 0, ...fields });
}

/** The `🔘 ` prefix and ` - @mention` suffix §3.4 L321 fixes around every block. */
function line(itemId: string, content: string, channel: string): string {
  return `🔘 ${content} - <a href="https://t.me/${itemId}">@${channel}</a>`;
}

describe("renderMember", () => {
  test("emits the §3.4 L321 shape: 🔘 prefix, content, and the @channel link", () => {
    const rendered = renderMember("chan/7", member({ summary: "Выбух", channel: "chan" }));

    expect(rendered).toBe(line("chan/7", "Выбух", "chan"));
    expect(rendered.startsWith("🔘 ")).toBe(true);
    expect(rendered.endsWith(' - <a href="https://t.me/chan/7">@chan</a>')).toBe(true);
  });

  test("§3.4 L319 — replaces a resolved [text](#N) token with an anchor", () => {
    const rendered = renderMember(
      "chan/7",
      member({ summary: "see [the report](#1) now", links: [{ id: 1, href: "https://e.by/r" }] }),
    );

    expect(rendered).toContain('see <a href="https://e.by/r">the report</a> now');
  });

  test("resolves several tokens in one summary, each against its own link id", () => {
    const rendered = renderMember(
      "chan/7",
      member({
        summary: "[one](#1) and [two](#2)",
        links: [
          { id: 2, href: "https://e.by/two" },
          { id: 1, href: "https://e.by/one" },
        ],
      }),
    );

    expect(rendered).toContain('<a href="https://e.by/one">one</a>');
    expect(rendered).toContain('<a href="https://e.by/two">two</a>');
  });

  /** AC-4.4 (§3.4 L352). */
  test("AC-4.4 — a [x](#3) token with no matching link degrades to plain `x`", () => {
    const rendered = renderMember(
      "chan/7",
      member({ summary: "a [x](#3) b", links: [{ id: 1, href: "https://e.by/r" }] }),
    );

    expect(rendered).toContain("a x b");
    expect(rendered).not.toContain("(#3)");
    expect(rendered).not.toContain("[x]");
    // The only anchor left is the trailing @mention — the token produced none.
    expect(rendered.match(/<a /g)).toHaveLength(1);
  });

  test("degrades every token when the member has no links at all", () => {
    const rendered = renderMember("chan/7", member({ summary: "[a](#1) [b](#2)", links: [] }));

    expect(rendered).toContain("a b");
    expect(rendered).not.toContain("(#1)");
    expect(rendered).not.toContain("(#2)");
  });

  /**
   * §3.4 L342 sends with `parse_mode: html`, so raw `<` and `&` in a summary
   * would be parsed as markup by Telegram and reject or corrupt the send.
   */
  test('HTML-escapes &, <, > and " in the summary text', () => {
    const rendered = renderMember("chan/7", member({ summary: 'M&S <b>x</b> "q" > y', links: [] }));

    expect(rendered).toContain("M&amp;S &lt;b&gt;x&lt;/b&gt; &quot;q&quot; &gt; y");
  });

  test("escapes the token text but leaves the substituted anchor as real markup", () => {
    const rendered = renderMember(
      "chan/7",
      member({ summary: "[A & B](#1)", links: [{ id: 1, href: "https://e.by/a?x=1&y=2" }] }),
    );

    expect(rendered).toContain('<a href="https://e.by/a?x=1&amp;y=2">A &amp; B</a>');
  });

  test("escapes an unresolved token's text rather than emitting raw markup", () => {
    const rendered = renderMember("chan/7", member({ summary: "[<b>x</b>](#9)", links: [] }));

    expect(rendered).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(rendered.match(/<a /g)).toHaveLength(1);
  });
});

describe("renderMembers", () => {
  test("§3.4 L318 — orders members by ts ascending", () => {
    const rendered = renderMembers({
      "chan/3": member({ summary: "third", ts: 300 }),
      "chan/1": member({ summary: "first", ts: 100 }),
      "chan/2": member({ summary: "second", ts: 200 }),
    });

    expect(rendered.split("\n").map((l) => l.split(" - ")[0])).toEqual([
      "🔘 first",
      "🔘 second",
      "🔘 third",
    ]);
  });

  test("§3.4 L318 — renders only the first 12 when 20 members are present", () => {
    const members: Record<string, MemberBlock> = {};
    for (let i = 1; i <= 20; i++) {
      members[`chan/${i}`] = member({ summary: `s${i}`, ts: i });
    }

    const lines = renderMembers(members).split("\n");

    expect(lines).toHaveLength(MEMBER_RENDER_LIMIT);
    expect(lines[0]).toContain('https://t.me/chan/1"');
    expect(lines[MEMBER_RENDER_LIMIT - 1]).toContain('https://t.me/chan/12"');
    expect(renderMembers(members)).not.toContain('https://t.me/chan/13"');
    expect(renderMembers(members)).not.toContain("s13");
  });

  /**
   * The tiebreak is a recorded decision, not spec text: `ts` alone is unstable
   * when one aggregate batch stamps several members from a single clock
   * reading, and an unstable order changes the rendered bytes on a replay,
   * breaking AC-3.7's byte-identical guarantee.
   */
  test("orders members sharing a ts deterministically by item id", () => {
    const forward = renderMembers({
      "chan/10": member({ summary: "ten", ts: 5 }),
      "chan/2": member({ summary: "two", ts: 5 }),
      "chan/9": member({ summary: "nine", ts: 5 }),
    });
    const reversed = renderMembers({
      "chan/9": member({ summary: "nine", ts: 5 }),
      "chan/2": member({ summary: "two", ts: 5 }),
      "chan/10": member({ summary: "ten", ts: 5 }),
    });

    expect(forward).toBe(reversed);
    expect(forward.split("\n").map((l) => l.split(" - ")[0])).toEqual([
      "🔘 ten",
      "🔘 two",
      "🔘 nine",
    ]);
  });

  /** AC-4.3 (§3.4 L351). */
  test("AC-4.3 — a member keyed abc/1 never renders content belonging to abc/12", () => {
    const rendered = renderMembers({
      "abc/1": member({ summary: "content of one", channel: "abc", ts: 1 }),
      "abc/12": member({ summary: "content of twelve", channel: "abc", ts: 2 }),
    });

    const blocks = rendered.split("\n");
    const one = blocks.find((b) => b.includes('<a href="https://t.me/abc/1">'));
    const twelve = blocks.find((b) => b.includes('<a href="https://t.me/abc/12">'));

    expect(one).toBe(line("abc/1", "content of one", "abc"));
    expect(one).not.toContain("twelve");
    expect(twelve).toBe(line("abc/12", "content of twelve", "abc"));
  });

  test("resolves each token against that member's own links, not a sibling's", () => {
    const rendered = renderMembers({
      "abc/1": member({
        summary: "[t](#1)",
        channel: "abc",
        ts: 1,
        links: [{ id: 1, href: "https://one.by" }],
      }),
      "xyz/2": member({
        summary: "[t](#1)",
        channel: "xyz",
        ts: 2,
        links: [{ id: 1, href: "https://two.by" }],
      }),
    });

    const blocks = rendered.split("\n");
    const first = blocks[0];
    const second = blocks[1];

    expect(first).toContain('<a href="https://one.by">t</a>');
    expect(first).not.toContain("two.by");
    expect(second).toContain('<a href="https://two.by">t</a>');
    expect(second).not.toContain("one.by");
  });

  test("renders each member's own channel in its @mention", () => {
    const rendered = renderMembers({
      "abc/1": member({ summary: "a", channel: "abc", ts: 1 }),
      "xyz/2": member({ summary: "b", channel: "xyz", ts: 2 }),
    });

    expect(rendered).toBe(`${line("abc/1", "a", "abc")}\n${line("xyz/2", "b", "xyz")}`);
  });

  test("returns an empty string for an empty members map", () => {
    expect(renderMembers({})).toBe("");
  });
});
