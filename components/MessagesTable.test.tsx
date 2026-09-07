// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MemberRow } from "../lib/dashboard/records";
import type { MessageListItem } from "../lib/domain/message";
import { MessagesTable, type PublishNowResult } from "./MessagesTable";

const row = (n: number, extra: Partial<MessageListItem> = {}): MessageListItem => ({
  id: `example/${n}`,
  status: "topublish",
  title: `Headline ${n}`,
  category: "politics",
  date: "2026-02-01",
  ts: 1_770_000_000_000 - n,
  tgChannel: "@target",
  memberCount: 0,
  ...extra,
});

type SaveFn = (id: string, delta: Record<string, string>) => Promise<void>;
type RepublishFn = (messageId: string) => Promise<void>;
type MembersFn = (messageId: string) => Promise<MemberRow[]>;
type DeleteFn = (ids: string[]) => Promise<void>;

let onSave: ReturnType<typeof vi.fn<SaveFn>>;
let onRepublish: ReturnType<typeof vi.fn<RepublishFn>>;
let onLoadMembers: ReturnType<typeof vi.fn<MembersFn>>;
let onDelete: ReturnType<typeof vi.fn<DeleteFn>>;

const MEMBERS: MemberRow[] = [
  { itemId: "chan_a/1", summary: "First summary", links: [], channel: "chan_a", ts: 1 },
  { itemId: "chan_b/2", summary: "Second summary", links: [], channel: "chan_b", ts: 2 },
];

beforeEach(() => {
  onSave = vi.fn<SaveFn>(async () => undefined);
  onRepublish = vi.fn<RepublishFn>(async () => undefined);
  onLoadMembers = vi.fn<MembersFn>(async () => MEMBERS);
  onDelete = vi.fn<DeleteFn>(async () => undefined);
});

afterEach(cleanup);

const rows = [row(1), row(2, { category: "sports", memberCount: 2 })];

const draw = (props: Partial<Parameters<typeof MessagesTable>[0]> = {}) =>
  render(
    <MessagesTable
      rows={rows}
      status="topublish"
      canEdit
      canAdmin
      onSave={onSave}
      onRepublish={onRepublish}
      onLoadMembers={onLoadMembers}
      onDelete={onDelete}
      {...props}
    />,
  );

describe("MessagesTable — §8.3 L798", () => {
  test("shows every column the section lists", () => {
    draw();

    for (const column of [
      "id",
      "title",
      "category",
      "status",
      "date",
      "tgChannel",
      "memberCount",
    ]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeDefined();
    }
  });

  describe("status tabs", () => {
    /** §8.2 L775 — `?status=topublish`, so each tab is a link, not local state. */
    test("links to each status, marking the current one", () => {
      draw();

      expect(screen.getByRole("link", { name: "published" }).getAttribute("href")).toBe(
        "/messages?status=published",
      );
      expect(screen.getByRole("link", { name: "topublish" }).getAttribute("aria-current")).toBe(
        "page",
      );
    });

    test("offers all three statuses", () => {
      draw();
      for (const status of ["topublish", "published", "error"]) {
        expect(screen.getByRole("link", { name: status })).toBeDefined();
      }
    });
  });

  describe("search (§8.3 L801)", () => {
    test("filters across visible columns", () => {
      draw();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "sports" } });

      expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
    });

    /** `ts` is not a visible column, so it must not match. */
    test("does not match a hidden column", () => {
      draw();
      fireEvent.change(screen.getByLabelText("Search"), { target: { value: "1769999999999" } });

      expect(screen.queryAllByTestId(/^row-/)).toHaveLength(0);
    });
  });

  describe("the member list — R26", () => {
    /**
     * Nothing projects `members`, so the panel is fetched when it opens. Loading
     * every row's members with the page would turn one query into a read per
     * row, for a panel most of them never open.
     */
    test("fetches nothing until a row is expanded", () => {
      draw();
      expect(onLoadMembers).not.toHaveBeenCalled();
    });

    test("fetches that row's members on expand", async () => {
      draw();
      fireEvent.click(
        within(screen.getByTestId("row-example/2")).getByRole("button", { name: /members/i }),
      );

      expect(onLoadMembers).toHaveBeenCalledWith("example/2");
      expect(await screen.findByText("First summary")).toBeDefined();
      expect(screen.getByText("Second summary")).toBeDefined();
    });

    test("shows the member's source channel", async () => {
      draw();
      fireEvent.click(
        within(screen.getByTestId("row-example/2")).getByRole("button", { name: /members/i }),
      );

      expect(await screen.findByText(/chan_a/)).toBeDefined();
    });

    /** Re-opening a panel must not re-read the base table. */
    test("does not refetch a panel that has already loaded", async () => {
      draw();
      const toggle = within(screen.getByTestId("row-example/2")).getByRole("button", {
        name: /members/i,
      });

      fireEvent.click(toggle);
      expect(await screen.findByText("First summary")).toBeDefined();
      fireEvent.click(toggle);
      fireEvent.click(toggle);

      expect(onLoadMembers).toHaveBeenCalledTimes(1);
    });
  });

  describe("inline edit", () => {
    test("saves only what changed", () => {
      draw();
      const target = screen.getByTestId("row-example/1");
      fireEvent.change(within(target).getByLabelText("title"), { target: { value: "Corrected" } });
      fireEvent.click(within(target).getByRole("button", { name: "Save" }));

      expect(onSave).toHaveBeenCalledWith("example/1", { title: "Corrected" });
    });

    /**
     * R37 — `status`, `date` and `memberCount` are shown but not editable:
     * `memberCount` is `size(members)` by §2.3 L155, `date` partitions
     * `date-index`, and `status` only moves through Re-publish.
     */
    test("status, date and memberCount are not editable", () => {
      draw();
      const target = screen.getByTestId("row-example/1");

      expect(within(target).queryByLabelText("status")).toBeNull();
      expect(within(target).queryByLabelText("date")).toBeNull();
      expect(within(target).queryByLabelText("memberCount")).toBeNull();
    });
  });

  describe("Re-publish (§8.4 L815)", () => {
    test("republishes the row", () => {
      draw();
      fireEvent.click(
        within(screen.getByTestId("row-example/1")).getByRole("button", { name: "Re-publish" }),
      );

      expect(onRepublish).toHaveBeenCalledWith("example/1");
    });

    test("an editor does not see it", () => {
      draw({ canAdmin: false });
      expect(screen.queryByRole("button", { name: "Re-publish" })).toBeNull();
    });
  });

  test("a viewer sees no Save button", () => {
    draw({ canEdit: false, canAdmin: false });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  /**
   * §8.4 L810 — `deleteRecords(table, ids[])`, `editor`, soft.
   *
   * *Reconciliation.* §8.3 L798's Messages row lists inline edit, Re-publish and
   * export, and not delete; §8.4 L810 defines the action over both tables and
   * `MessageRepo.softDelete` implements it. The action is followed: a message
   * built from a mis-scraped item is otherwise unremovable from the tab an
   * operator works through.
   */
  describe("Delete", () => {
    const deleteButton = () => screen.queryByRole("button", { name: "Delete selected" });

    test("deletes exactly the rows that were selected", () => {
      draw();
      fireEvent.click(screen.getByLabelText("Select example/2"));

      const trigger = deleteButton();
      expect(trigger).not.toBeNull();
      if (trigger !== null) fireEvent.click(trigger);

      expect(onDelete).toHaveBeenCalledWith(["example/2"]);
    });

    test("selecting twice deselects", () => {
      draw();
      fireEvent.click(screen.getByLabelText("Select example/1"));
      fireEvent.click(screen.getByLabelText("Select example/1"));

      const trigger = deleteButton();
      if (trigger !== null) fireEvent.click(trigger);

      expect(onDelete).not.toHaveBeenCalled();
    });

    /** A delete of nothing would still revalidate the page and read as a success. */
    test("does nothing with an empty selection", () => {
      draw();

      const trigger = deleteButton();
      if (trigger !== null) fireEvent.click(trigger);

      expect(onDelete).not.toHaveBeenCalled();
    });

    /**
     * The rows come back from the server without the deleted ones (R16), so a
     * selection kept across that render would address ids the table no longer
     * shows.
     */
    test("clears the selection after deleting", () => {
      draw();
      fireEvent.click(screen.getByLabelText("Select example/1"));

      const trigger = deleteButton();
      if (trigger !== null) fireEvent.click(trigger);
      expect(screen.getByLabelText<HTMLInputElement>("Select example/1").checked).toBe(false);
    });

    test("a viewer sees neither the checkboxes nor the button", () => {
      draw({ canEdit: false, canAdmin: false });

      expect(deleteButton()).toBeNull();
      expect(screen.queryByLabelText("Select example/1")).toBeNull();
    });
  });

  test("says so when a status has no messages", () => {
    draw({ rows: [] });
    expect(screen.getByText(/no messages/i)).toBeDefined();
  });

  /** Titles are third-party text; React escapes them and this stops that regressing. */
  test("escapes a title containing markup", () => {
    const { container } = draw({ rows: [row(1, { title: '<img src=x onerror="alert(1)">' })] });
    expect(container.querySelector("img")).toBeNull();
  });
});

/**
 * R53 — "Publish now" runs the deployed publish stage against the pending
 * backlog. §8.4 L815's Re-publish is the queue route and waits out §7.3 L648's
 * 300 s delay; this is the one that sends on the operator's timescale.
 */
describe("Publish now — R53", () => {
  let onPublishNow: ReturnType<typeof vi.fn<(max: number) => Promise<PublishNowResult>>>;

  beforeEach(() => {
    onPublishNow = vi.fn(async () => ({ published: 2, failed: 0 }));
  });

  const button = () => screen.queryByRole("button", { name: "Publish now" });

  test("an admin on the topublish tab publishes the capped batch", async () => {
    draw({ onPublishNow });

    const trigger = button();
    expect(trigger).not.toBeNull();
    if (trigger !== null) fireEvent.click(trigger);

    expect(onPublishNow).toHaveBeenCalledWith(10);
    expect(await screen.findByText("published 2, 0 failed")).toBeDefined();
  });

  /** The backlog it drains is the `topublish` one; on any other tab the button would lie. */
  test("is absent on the published tab", () => {
    draw({ status: "published", onPublishNow });

    expect(button()).toBeNull();
  });

  test("is absent without the admin role", () => {
    draw({ canAdmin: false, onPublishNow });

    expect(button()).toBeNull();
  });

  test("an operator can publish fewer than the cap", () => {
    draw({ onPublishNow });

    fireEvent.change(screen.getByLabelText("publish at most"), { target: { value: "3" } });
    const trigger = button();
    if (trigger !== null) fireEvent.click(trigger);

    expect(onPublishNow).toHaveBeenCalledWith(3);
  });

  test("reports what the stage could not send", async () => {
    onPublishNow = vi.fn(async () => ({ published: 1, failed: 2 }));
    draw({ onPublishNow });

    const trigger = button();
    if (trigger !== null) fireEvent.click(trigger);

    expect(await screen.findByText("published 1, 2 failed")).toBeDefined();
  });
});

/** The same header controls as the Sources table, over §8.3 L798's columns. */
describe("filter and sort — the header row", () => {
  const idsOnScreen = () =>
    screen
      .getAllByRole("row")
      .map((r) => r.getAttribute("data-testid"))
      .filter((id): id is string => id !== null);

  test("a column filter narrows to that column alone", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Filter category"), { target: { value: "sports" } });

    expect(idsOnScreen()).toEqual(["row-example/2"]);
  });

  test("the filter boxes survive a filter that matches nothing", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Filter title"), { target: { value: "nothing" } });

    expect(screen.getByText(/no messages/i)).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Filter title").value).toBe("nothing");
  });

  test("a header click sorts, and a third clears it", () => {
    draw({ rows: [row(2), row(1)] });
    const header = () => screen.getByRole("button", { name: "id" });

    expect(idsOnScreen()).toEqual(["row-example/2", "row-example/1"]);

    fireEvent.click(header());
    expect(idsOnScreen()).toEqual(["row-example/1", "row-example/2"]);

    fireEvent.click(header());
    expect(idsOnScreen()).toEqual(["row-example/2", "row-example/1"]);

    // §8.5 L832 reads `status-index` with `ts` descending, so the cleared state
    // is "newest first" — an order the cycle has to be able to return to.
    fireEvent.click(header());
    expect(idsOnScreen()).toEqual(["row-example/2", "row-example/1"]);
  });

  test("numeric columns sort numerically", () => {
    draw({
      rows: [row(1, { memberCount: 3 }), row(2, { memberCount: 12 })],
    });
    fireEvent.click(screen.getByRole("button", { name: "memberCount" }));

    expect(idsOnScreen()).toEqual(["row-example/1", "row-example/2"]);
  });

  /**
   * The member panel spans the whole row. With the select checkbox added the
   * table has one more column than it did, and a stale span would leave the
   * panel short of the edge.
   */
  test("the member panel spans every column, checkbox included", async () => {
    draw();
    fireEvent.click(
      within(screen.getByTestId("row-example/2")).getByRole("button", { name: /members/ }),
    );

    const panel = await screen.findByText("First summary");
    const cell = panel.closest("td");
    expect(cell?.getAttribute("colspan")).toBe("10");
  });
});
