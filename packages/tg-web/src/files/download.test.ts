import { describe, expect, test } from "vitest";
import { exportFilename } from "./download";

describe("exportFilename", () => {
  test("names the table and the UTC day", () => {
    expect(exportFilename("sources", new Date("2026-10-20T23:30:00Z"))).toBe(
      "sources-2026-10-20.csv",
    );
  });
});
