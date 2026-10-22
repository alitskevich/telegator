# 4. Classify (stage 2: analyze)

Analyze asks the model what one post is about, drops what is not news, and passes the rest to aggregate.

## 1. Steps

1. **Parse** the payload as a scraped item (QU-13).
2. **Pre-filter.** Trim the body. If it is empty, or it is exactly one link token (`^\[[^\]]*\]\(#\d+\)$`), drop the item and count `ItemsSkipped` split `nobody`. No model call.
3. **Classify** the body (§2). Count `ItemsClassified` split by the returned category.
4. **Route**, the first rule that matches:

| Order | Condition | Action |
| --- | --- | --- |
| 1 | `category` is empty | **Throw** `classification returned no category` (retry). |
| 2 | `importance = low` | Drop; `ItemsSkipped` split `low`. |
| 3 | `category = "crime&law"` | Drop; `ItemsSkipped` split `category`. ⚠️ Unreachable: the enum has no such value. Keep it as written (see [09-acceptance.md](09-acceptance.md) §2). |
| 4 | otherwise | Normalise (§4), queue for **aggregate**, count `ItemsAnalyzed`. |

- **CL-1** A model error, a malformed answer, or an answer that fails the shape (for example a summary over 220 characters) MUST throw, so the queue retries.

## 2. The classification call

- **CL-2** Endpoint: an Anthropic-compatible Messages API at `https://openrouter.ai/api` (the client adds `/v1/messages`). Key: secret `OPENROUTER_API_KEY`.
- **CL-3** Request:

| Field | Value |
| --- | --- |
| `model` | `anthropic/claude-haiku-4.5` |
| `max_tokens` | 2000 |
| `output_config.effort` | `low` (MAY be left out for a model that does not accept it) |
| `output_config.format` | `{type: "json_schema", schema: <§3 as JSON Schema>}` |
| `system` | the prompt below, verbatim |
| `messages` | one user message whose content is the item `body` |

- **CL-4** The system prompt, byte for byte (wording changes model behaviour, so it MUST NOT be "improved"):

```text
You are all about analyzing the ongoing news articles, keeping strong focus on matters of facts.
Your responses MUST follow the rules:
- respond in JSON format! according responseSchema provided.
- preserve '[text](#[1-9]+)' tokens intact;
- no extra punctuation; no any emoji;
- keep neutral tone, avoid hate speech;
```

## 3. The answer shape

The descriptions are part of the contract: they reach the model only through the JSON Schema.

| Field | Type | Required | Description sent to the model |
| --- | --- | --- | --- |
| `title` | string | yes | Essential subject in three words, English. |
| `summary` | string ≤ 220 | yes | Brief factual matter — no implications, opinions or judgements. In Belarusian. At most 220 characters. |
| `country` | string | yes | ISO-3166 alpha-2 code. |
| `location` | string | yes | City or region, English. |
| `category` | enum (below) | yes | One of the listed categories. |
| `importance` | `high` \| `low` | yes | high \| low. "Diminish any of sports, criminal accidents, funny, temporary, and local content." |
| `peoples` | string | no | Comma-separated person names, Latin letters, English. |
| `properNames` | string | no | Comma-separated places, organisations, events, English. |
| `tags` | string[] | no | 3–5 related tags, English. |

**Categories**, exactly these 29, in this order:

```text
art&fashion, crime, culture&history, news-digest, economics&finance, education,
energy, entertainment, sports, environmental, geopolitics, health, human-rights,
infrastructure, international, media, other, politics, real-estate, science,
social, technology, internet, traditions, tourism, traffic, war, incidents, nature
```

- **CL-5** The summary keeps the body's link tokens, so publish can turn them back into links.

## 4. Normalise

The analyzed item is the scraped item with:

- `title`, `summary`, `location`, `category`, `importance`, `peoples`, `properNames` from the answer;
- `country` = the answer's country, trimmed and **uppercased**;
- `tags` = `mergeTags(answer.tags, source tags)`: AI tags first, then the source's, each once;
- `id`, `body`, `links`, `image`, `forwardedFrom`, `date`, `kind` passed through.

- **CL-6** The source's `category` is a default only: the model's category replaces it.
- **CL-7** Tags from the model drive routing to targets ([06-publish.md](06-publish.md) §1), so source tags and AI tags together decide where a story goes.
