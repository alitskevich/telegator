import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PIE_PALETTE } from "../lib/ui/pie.js";
import { PieChart } from "./PieChart.js";

const render = (slices: { label: string; value: number }[], title = "Status") =>
  renderToStaticMarkup(<PieChart title={title} slices={slices} />);

describe("PieChart", () => {
  test("draws one path per slice", () => {
    const markup = render([
      { label: "a", value: 1 },
      { label: "b", value: 3 },
    ]);

    expect([...markup.matchAll(/<path/g)]).toHaveLength(2);
    expect(markup).toContain("M 100 100 L 100 20 A 80 80 0 0 1 180 100 Z");
  });

  /** §8.5 L776's special case, reaching the DOM and not only the geometry. */
  test("draws a circle when one slice is the whole chart", () => {
    const markup = render([{ label: "politics", value: 7 }]);

    expect(markup).toContain("<circle");
    expect(markup).not.toContain("<path");
  });

  test("uses the palette", () => {
    expect(
      render([
        { label: "a", value: 1 },
        { label: "b", value: 1 },
      ]),
    ).toContain(PIE_PALETTE[0]);
  });

  /**
   * A pie chart without labels is decoration. §8.3's operator has to know which
   * wedge is `topublish`, so the legend carries the label and the count.
   */
  test("labels every slice with its value", () => {
    const markup = render([
      { label: "topublish", value: 4 },
      { label: "published", value: 12 },
    ]);

    expect(markup).toContain("topublish");
    expect(markup).toContain("published");
    expect(markup).toContain("12");
  });

  /**
   * An empty pipeline is the normal state of a new deployment, and it must read
   * as "nothing yet" rather than as a broken component.
   */
  test("says so when there is nothing to draw", () => {
    const markup = render([]);

    expect(markup).not.toContain("<path");
    expect(markup).not.toContain("<circle");
    expect(markup.toLowerCase()).toContain("no data");
  });

  test("carries the title", () => {
    expect(render([{ label: "a", value: 1 }], "Categories")).toContain("Categories");
  });

  /** The viewBox has to match the geometry, or every chart is cropped or floating. */
  test("the viewBox frames the centre and radius the geometry uses", () => {
    expect(render([{ label: "a", value: 1 }])).toContain('viewBox="0 0 200 200"');
  });
});
