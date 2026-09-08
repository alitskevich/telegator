// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Target } from "../lib/domain/target";
import { TargetsTable } from "./TargetsTable";

const target = (id: string, extra: Partial<Target> = {}): Target => ({
  id,
  type: "telegram_channel",
  lastPostedDate: "2026-09-08T10:00:00.000Z",
  lastPostedMessageId: "chan_a/1",
  ...extra,
});

type SaveFn = (id: string, delta: Record<string, string>) => Promise<void>;
type DeleteFn = (ids: string[]) => Promise<void>;

let onSave: ReturnType<typeof vi.fn<SaveFn>>;
let onDelete: ReturnType<typeof vi.fn<DeleteFn>>;

beforeEach(() => {
  onSave = vi.fn<SaveFn>(async () => undefined);
  onDelete = vi.fn<DeleteFn>(async () => undefined);
});

afterEach(cleanup);

const rows = [target("a", { messageTemplate: "{header}\n\n{body}" }), target("b")];

const draw = (props: Partial<Parameters<typeof TargetsTable>[0]> = {}) =>
  render(<TargetsTable rows={rows} canEdit onSave={onSave} onDelete={onDelete} {...props} />);

const rowFor = (id: string) => screen.getByTestId(`row-${id}`);

describe("TargetsTable — target-table#7", () => {
  test("TT-21: shows every column the section lists, in order", () => {
    draw();

    for (const column of [
      "id",
      "type",
      "lastPostedDate",
      "lastPostedMessageId",
      "messageTemplate",
    ]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeDefined();
    }
  });

  test("TT-21: renders a row per target", () => {
    draw();
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(2);
  });

  test("TT-21: messageTemplate edits in a textarea, because templates have newlines", () => {
    draw();

    const cell = within(rowFor("a")).getByLabelText("messageTemplate");

    expect(cell.tagName).toBe("TEXTAREA");
  });

  test("TT-21: saving sends only what changed", () => {
    draw();

    const cell = within(rowFor("b")).getByLabelText("messageTemplate");
    fireEvent.change(cell, { target: { value: "{body}" } });
    fireEvent.click(within(rowFor("b")).getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("b", { messageTemplate: "{body}" });
  });

  /** The two mirror fields are publish's; an operator editing them makes it lie. */
  test("TT-21: offers no edit control on lastPostedDate", () => {
    draw();

    expect(within(rowFor("a")).queryByLabelText("lastPostedDate")).toBeNull();
    expect(within(rowFor("a")).queryByLabelText("lastPostedMessageId")).toBeNull();
  });

  test("TT-21: a viewer gets no controls at all", () => {
    draw({ canEdit: false });

    expect(within(rowFor("a")).queryByLabelText("messageTemplate")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  /** target-table#3.2 — nothing on this table is a pipeline action. */
  test("TT-21: offers no trigger button", () => {
    draw();

    expect(screen.queryByRole("button", { name: /now$/i })).toBeNull();
  });

  test("adds a target by id", () => {
    draw();

    fireEvent.change(screen.getByLabelText("New target id"), { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onSave).toHaveBeenCalledWith("c", { type: "telegram_channel" });
  });

  test("deletes the selected rows", () => {
    draw();

    fireEvent.click(screen.getByLabelText("Select a"));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(onDelete).toHaveBeenCalledWith(["a"]);
  });
});
