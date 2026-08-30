// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MemberRow } from "../lib/dashboard/records";
import type { MessageListItem } from "../lib/domain/message";
import { MessagesTable } from "./MessagesTable";

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

let onSave: ReturnType<typeof vi.fn<SaveFn>>;
let onRepublish: ReturnType<typeof vi.fn<RepublishFn>>;
let onLoadMembers: ReturnType<typeof vi.fn<MembersFn>>;

const MEMBERS: MemberRow[] = [
  { itemId: "chan_a/1", summary: "First summary", links: [], channel: "chan_a", ts: 1 },
  { itemId: "chan_b/2", summary: "Second summary", links: [], channel: "chan_b", ts: 2 },
];

beforeEach(() => {
  onSave = vi.fn<SaveFn>(async () => undefined);
  onRepublish = vi.fn<RepublishFn>(async () => undefined);
  onLoadMembers = vi.fn<MembersFn>(async () => MEMBERS);
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
      {...props}
    />,
  );

describe("MessagesTable — §8.3 L742", () => {
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
    /** §8.2 L722 — `?status=topublish`, so each tab is a link, not local state. */
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

  describe("search (§8.3 L744)", () => {
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
     * `memberCount` is `size(members)` by §2.3 L145, `date` partitions
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

  describe("Re-publish (§8.4 L753)", () => {
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
