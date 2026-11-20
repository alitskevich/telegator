---
theme: telegator
mode: dark
ground: base-300 oklch(16.5% 0.012 258)
panel: base-100 oklch(21% 0.013 258)
zone: base-200 oklch(25% 0.014 258)
ink: base-content oklch(93% 0.006 258)
signal: primary oklch(74% 0.16 152)
healthy: success oklch(80% 0.1 172)
selected: accent oklch(86% 0.015 258)
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
is drawn once, on the Dashboard page, and every manual trigger sits on the node
it acts on. **The memorable thing** is the error count: the one red figure
in the console, on the Dashboard's errors card and over the Audit page's failed items.

## Colors

| Role | Token | Use |
| --- | --- | --- |
| Ground | `base-300` | The canvas behind everything |
| Panel | `base-100` | Cards, the header, table bodies |
| Zone | `base-200` | Inside a panel: table headers, toolbars, the pipeline nodes |
| Ink | `base-content`, `/70` for secondary | All text |
| Signal | `primary` | The primary action, the current nav item, a selected node's edge and icon |
| Healthy | `success` | A mint, cooler than the signal: `published`, `done`, `ok` badges |
| Selected | `accent` | A quiet light slate: the chosen segment of a radio group, tag chips |
| Alarm | `error` | Failed items, failure counts and failure toasts only |

The status badges use `success` / `warning` / `error`. Nothing else is coloured:
node icons and queue chips are ink. Ink is near-neutral (chroma ≤ 0.015); words are
never fainter than `base-content/60`, icons never fainter than `/40`.

| Pair | Contrast |
| --- | --- |
| Ink on ground / panel / zone | 15.7 / 14.4 / 13.0 |
| Ink `/60` on ground / panel / zone | 6.1 / 5.9 / 5.6 |
| Ink `/40` (icons) on panel / zone | 3.3 / 3.3 |
| `primary` on ground (focus ring) | 8.9 |
| `primary-content` on `primary` | 8.5 |
| `error` on zone | 4.7 |
| `error-content` on `error` | 5.6 |
| `accent-content` on `accent` | 12.1 |

The browser's own surfaces follow the theme: selection is `primary` at 30%, the
caret, checkboxes and the focus ring are `primary`, the scrollbar is ink at 22%,
placeholders ink at 62%.

## Typography

Fira Sans, one face; Fira Mono only inside `<pre>` (a cause, a payload). Sizes: `text-xs` 13px (table cells, captions, and DaisyUI's `sm`/`xs` controls, raised to it in `index.css`), `text-sm`
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
- **Pipeline node** — a zone with a `base-content/15` edge, `primary` when selected: icon (ink, `primary` when selected), title, caption, figure; a stage with a queue adds its in-queue chip on the top-right edge, a paused stage a "Paused" chip on the top-left.
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
- Don't mark a card with a coloured edge; the figure carries the colour.
- Don't animate size or position; `prefers-reduced-motion` drops every transition and loop.

## Responsive

Below `lg` the diagram stacks vertically and its arrows turn downward; tables
scroll inside their panel, never the page.

## Known gaps

One dark theme only; a light theme is a candidate, not a promise.
