import { describe, expect, test } from "vitest";
import { header, MAX_MAIL_BODY_LENGTH, mailContent } from "./mime";
import type { MessagePart } from "./types";

const data = (text: string) => ({ data: Buffer.from(text).toString("base64url") });

const mail = (subject: string, ...parts: MessagePart[]): MessagePart => ({
  mimeType: "multipart/alternative",
  headers: [{ name: "Subject", value: subject }],
  parts,
});

describe("mailContent", () => {
  test("puts the subject first and prefers the plain part, with bare URLs as tokens", () => {
    const payload = mail(
      "Digest",
      { mimeType: "text/plain", body: data("Read https://e.by/a.\r\n\r\n\r\n\r\nBye") },
      { mimeType: "text/html", body: data("<p>ignored</p>") },
    );

    expect(mailContent(payload)).toEqual({
      body: "Digest\n\nRead [https://e.by/a](#1).\n\nBye",
      links: [{ id: 1, href: "https://e.by/a" }],
    });
  });

  test("falls back to the HTML part, without CSS, comments or image-only links", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body><!--[if mso]>x<![endif]-->" +
      '<p>Hello <a href="https://e.by/r">the report</a></p>' +
      '<div><a href="https://e.by/logo"><img src="l.png"></a>World</div></body></html>';
    const payload = mail("News", {
      mimeType: "multipart/related",
      parts: [{ mimeType: "text/html", body: data(html) }],
    });

    const { body, links } = mailContent(payload);
    expect(body).toBe("News\n\nHello [the report](#1)\nWorld");
    expect(links[0]).toEqual({ id: 1, href: "https://e.by/r" });
  });

  test("a mail with no text part is its subject alone, capped in length", () => {
    expect(mailContent(mail("Only a subject")).body).toBe("Only a subject");
    expect(mailContent(mail("x".repeat(MAX_MAIL_BODY_LENGTH + 5))).body).toHaveLength(
      MAX_MAIL_BODY_LENGTH,
    );
  });
});

test("header names compare case-insensitively", () => {
  expect(header({ headers: [{ name: "SUBJECT", value: "Hi" }] }, "Subject")).toBe("Hi");
});
