---
theme: telegator
mode: dark
ground: base-300 oklch(16.5% 0.016 258)
panel: base-100 oklch(21% 0.018 258)
zone: base-200 oklch(25% 0.02 258)
ink: base-content oklch(92% 0.012 258)
signal: primary oklch(74% 0.16 152)
alarm: error oklch(66% 0.2 25)
font: Fira Sans
radius: field 0.375rem · box 0.5rem · pill 1rem
---

# Telegator console — design

## Overview

A night-shift operations console for one pipeline. Work screen only: tables,
figures and one diagram, read many times a day. It should feel like an
instrument panel: calm until something needs a person.

**The idea.** The pipeline *is* the interface: the chain of stages (docs/telegator.md §1)
is drawn once, on the Pipeline page, and every manual trigger sits on the node
it acts on. **The memorable thing** is the error count: the one red figure
in the console, on the Errors node below the chain.

## Colors

| Role | Token | Use |
| --- | --- | --- |
| Ground | `base-300` | The canvas behind everything |
| Panel | `base-100` | Cards, the header, table bodies |
| Zone | `base-200` | Inside a panel: table headers, toolbars, the selected node |
| Ink | `base-content`, `/70` for secondary | All text |
| Signal | `primary` | The primary action, the current nav item, a selected node's edge |
| Alarm | `error` | Failed items and failure toasts only |

The status badges use `success` / `warning` / `error`. Nothing else is coloured.

## Typography

Fira Sans, one face. Sizes: `text-xs` 13px (table cells, captions), `text-sm`
(body), `text-lg` (panel titles), `text-3xl` (figures), `text-4xl` (page
titles). Numbers use tabular figures, set once on `html`.

## Layout

A sticky header with the nav; under it one `max-w-[1400px]` column with a 24px
gutter (16px on a phone). Panels sit 16px apart. A page is a title row, then
one dominant block: the stat row, the diagram, or the table.

## Elevation and shapes

Panels are told apart by grade, not by shadow: ground → panel → zone. Only
toasts and the user menu float (`shadow-overlay`). Fields round 6px, panels
8px, badges and tabs are pills.

## Components

- **Stat card** — label, figure, note; the errors card turns `error` above zero.
- **Donut** — a `conic-gradient` ring with a legend; empty reads "No data yet".
- **Pipeline node** — icon, title, caption, figure; a stage with a queue adds its in-queue chip. The Errors node stands apart and turns red above zero.
- **Records table** — DaisyUI `table-sm`, sticky header with a filter row,
  inline inputs where the operator may write. A message with rejected sends
  carries a red count beside its expand button: the rejections no later
  successful post on that target has resolved.
- **Audit list** — one rejected send per line: a muted line of when, target and
  method, then Telegram's reason in `error`. Used in a message's panel and on
  the Audit page.

## Do's and Don'ts

- Do show `—` for a number that could not be read, never `0`.
- Do arm destructive actions: the second press names the count.
- Don't use the alarm colour for anything but failed items and failures.
- Don't add a second accent, a gradient, glass, or a monospace label.

## Responsive

Below `lg` the diagram stacks vertically and its arrows turn downward; tables
scroll inside their panel, never the page.

## Known gaps

One dark theme only; a light theme is a candidate, not a promise.
