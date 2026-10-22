# 6. Publish (stage 4)

Publish sends one message to every target that wants it. The first time it **sends** a post; after that it **edits** the same post.

## 1. Routing

- **PB-1** A target **receives** a message when the target has at least one tag and the message carries **every** target tag, compared case-insensitively. A target with no tags receives nothing.
- **PB-2** Only non-deleted targets are considered.

## 2. Algorithm

1. Load the message. If it is missing, deleted, or `status ≠ topublish`, **return** (skip, not a failure).
2. For each receiving target:
   1. **Existing post** = `posts[target]`; else, for the first target of the legacy `tgChannel` list (DA-8) only, `{tgId, tgAt ?? 0}` from the legacy fields when `tgId` is non-empty.
   2. If an existing post has `tgAt ≥ message.ts`, it is **current**: skip this target. (Telegram rejects an edit that changes nothing.)
   3. Assemble (§3–§5) with the target's template and the existing post's `tgId`.
   4. Call the bot (§6).
   5. **Rejected** → count `TelegramApiErrors` split by method; write a `send` audit entry `{messageId, target, method, error, at}` (a failed audit write is logged only); remember `"{target} ({method}): {error}"`; continue with the next target.
   6. **Accepted** → `posts[target] = {tgId: existing tgId, else the returned message_id as a string; tgAt: now}`, and **save `posts` at once** (so a retry never posts twice). Best-effort: set the target's `lastPostedDate` (ISO now) and `lastPostedMessageId` (the message id). Count `MessagesPublished` for a send, `MessagesEdited` for an edit.
3. If any target rejected, **throw** (retry) with the message `telegram rejected {part1}; {part2}; …`.
4. Otherwise set `status = published`, `ts = now`. A message that no target receives is marked `published` with no post.

- **PB-3** **Republish** (admin): for an existing, non-deleted message, set `status = topublish`, `ts = now`, then `requestPublish`. The new `ts` makes every post non-current, so every target is edited.
- **PB-4** **Publish now** (admin, `max` 1–10): queue a publish with **no delay** and no fixed id for each of the newest `max` `topublish` messages (by `ts` descending).
- ⚠️ If saving `posts` fails right after an accepted send, the retry posts again. This is rare and accepted.

## 3. The built-in layout

All text uses Telegram **HTML** parse mode. `escape(s)` replaces `&`, `<`, `>`, `"` with `&amp;`, `&lt;`, `&gt;`, `&quot;` (`&` first).

**Header**:

```text
<b>⚡️</b> <i>{date}</i> <b>{parts}</b>
```

`parts` = the non-blank values of [`country` uppercased, `location`, `category`], each trimmed and escaped, joined by a comma and a space. With no parts, the header ends after `</i>`. `date` is not escaped.

**Member block**, one per line. Take members sorted by `ts` ascending, ties broken by item id (plain code-unit compare), the first **12**:

```text
🔘 {summary} - <a href="https://t.me/{itemId}">@{channel}</a>
🔘 {summary} - ✉ {channel}            ← when channel contains "@" (a mail sender)
```

`summary` is escaped, then each `[text](#N)` becomes `<a href="{escape(href)}">text</a>` when the member has link N, else just `text`. `itemId` and `channel` are escaped.

**Hashtag line**. Collect tokens in this order: `category`, `location`, `peoples` (each split on `,` and trimmed), then `tags`, then each title word (split on whitespace) **longer than 4 characters** before cleaning, then `date_{date}`, then `ts_{ts}`. For each token:

- skip it if blank or `none` / `null` (any case);
- clean: each whitespace or `-` → `_`; remove `.,@!'"()`; lowercase; prefix `#`;
- skip a bare `#`; keep the first occurrence only.

Join with single spaces. Example: `date_2026-08-29` → `#date_2026_08_29`.

**Text**:

```text
{header}
                              ← blank line
{block 1}
…
{block n}
                              ← blank line, only when the hashtag line is non-empty
{hashtag line}
```

## 4. Target template

- **PB-5** A non-blank `messageTemplate` replaces the layout. Each `{name}` (letters only) is replaced by:

| Placeholder | Value |
| --- | --- |
| `{header}`, `{body}`, `{hashtags}` | The header, the member blocks joined by `\n`, the hashtag line, as HTML (not escaped again). |
| `{title}`, `{category}`, `{location}` | The message field, escaped; empty if absent. |
| `{country}` | The country uppercased, escaped. |
| `{date}` | The date key. |
| anything else | empty string |

- **PB-6** Then collapse every run of 3+ newlines to 2, and trim.

## 5. Fitting and send mode

- **PB-7** Telegram's text limit is **4096** characters. Try in order and keep the first that fits: (a) all blocks with hashtags; (b) all blocks without hashtags; (c) without hashtags, dropping blocks from the end, down to 1 block. If nothing fits, send 1 block without hashtags and let Telegram reject it. A template without `{body}` or `{hashtags}` cannot shrink.
- **PB-8** `disable_web_page_preview` = `title` is non-blank **or** `image` is non-blank.
- **PB-9** Method:
  - an existing `tgId` → `editMessageText` (never a photo: an edit cannot change media);
  - else a non-blank `image` and text ≤ **1012** characters → `sendPhoto` with the text as caption;
  - else `sendMessage`.
- **PB-10** Chat id = `@{target}`, unless the target already starts with `@`.
- **PB-11** The same stored message MUST give the same bytes every time, so a retry or an unchanged edit is identical.

## 6. The bot client

- **PB-12** Each call is `POST https://api.telegram.org/bot{token}/{method}` with JSON: `chat_id`, `text` or `photo` + `caption`, `parse_mode: "HTML"`, and `disable_web_page_preview` (send and edit). `message_id` is sent as an integer when it parses as one.
- **PB-13** **Success** is the envelope's `ok: true`, not the HTTP status (Telegram answers some errors with HTTP 200). A body that is not an envelope fails with `unrecognised Telegram response (HTTP {status})`.
- **PB-14** **Pacing.** After every attempt, wait at least **3 s**.
- **PB-15** **Rate limit.** If the answer carries `parameters.retry_after` (seconds), or the status is 429 (fallback **60 s**), wait `max(delay, 3 s)` and try **once** more. At most two attempts.
- **PB-16** **Error text.** On HTTP 401 or 404, add `: the bot token is invalid; check TELEGRAM_BOT_TOKEN`. On `Bad Request: chat not found`, add `: no public channel {chat_id}, or a private one without the bot; check the target id`. A transport error gives its message. The token MUST be replaced by `[redacted]` in every text (G-6).
- **PB-17** `TelegramApiErrors` counts each send that is still rejected after the retry (§2 step 2.5). A 429 that the retry rescues is logged as a warning, not counted.
