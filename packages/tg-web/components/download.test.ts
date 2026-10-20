// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { downloadText, exportFilename } from "./download";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadText", () => {
  test("hands the browser the text under the name it should save it as", () => {
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });

    downloadText("sources-2026-09-09.csv", "id,status\nyigal_levin,ok");

    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("sources-2026-09-09.csv");
    expect(decodeURIComponent(clicked[0]?.href ?? "")).toContain("id,status\nyigal_levin,ok");
  });

  /** Appended so Firefox honours the click; a console open all day must not
      accumulate one dead anchor per press. */
  test("leaves nothing behind in the document", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    downloadText("targets-2026-09-09.csv", "id\nfirst");

    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("exportFilename", () => {
  test("names the table and the day it was taken", () => {
    expect(exportFilename("sources", new Date("2026-09-09T21:45:00Z"))).toBe(
      "sources-2026-09-09.csv",
    );
  });
});
