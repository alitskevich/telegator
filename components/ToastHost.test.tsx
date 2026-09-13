// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TOAST_LIMIT, TOAST_TTL_MS } from "../lib/ui/toasts";
import { ToastHost, useToasts } from "./ToastHost";

afterEach(cleanup);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A button per kind, so a test presses what an operator presses. */
function Probe() {
  const toasts = useToasts();
  return (
    <>
      <button type="button" onClick={() => toasts.report("Scraped 7 items")}>
        succeed
      </button>
      <button type="button" onClick={() => toasts.reportError("Lambda unreachable")}>
        fail
      </button>
    </>
  );
}

const draw = () =>
  render(
    <ToastHost>
      <Probe />
    </ToastHost>,
  );

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("ToastHost", () => {
  test("shows a result and retires it once its time is up", () => {
    draw();
    press("succeed");

    expect(screen.getByText("Scraped 7 items")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(TOAST_TTL_MS);
    });

    expect(screen.queryByText("Scraped 7 items")).toBeNull();
  });

  /**
   * A failure is announced rather than merely displayed: the operator is looking
   * at the table they just acted on, not at the corner of the page.
   */
  test("announces an error and keeps it until it is dismissed", () => {
    draw();
    press("fail");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Lambda unreachable");

    act(() => {
      vi.advanceTimersByTime(TOAST_TTL_MS * 10);
    });
    expect(screen.getByText("Lambda unreachable")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("Lambda unreachable")).toBeNull();
  });

  test("a result is a status, not an alert — it interrupts nothing", () => {
    draw();
    press("succeed");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Scraped 7 items");
  });

  test("stacks no more than the limit", () => {
    draw();
    for (let n = 0; n <= TOAST_LIMIT; n += 1) press("succeed");

    expect(screen.getAllByRole("status")).toHaveLength(TOAST_LIMIT);
  });

  /** Nothing is rendered until something is reported, so it cannot cover the page. */
  test("renders nothing of its own while there is nothing to say", () => {
    draw();

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("useToasts outside a host", () => {
  /**
   * A silent no-op default would let a page ship with its reports going
   * nowhere, and every test of it would still pass.
   */
  test("throws, naming what is missing", () => {
    expect(() => render(<Probe />)).toThrow(/ToastHost/);
  });
});
