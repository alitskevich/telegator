import { describe, expect, test } from "vitest";
import { fill } from "./fill";

describe("fill", () => {
  test("fills every named hole", () => {
    expect(fill("Consumed {consumed} from {queue}", { consumed: 7, queue: "analyze" })).toBe(
      "Consumed 7 from analyze",
    );
  });

  test("zero is a value, not a gap", () => {
    expect(fill("Replayed {replayed}", { replayed: 0 })).toBe("Replayed 0");
  });

  test("a hole with no value stays visible", () => {
    expect(fill("From {queue}", {})).toBe("From {queue}");
  });
});
