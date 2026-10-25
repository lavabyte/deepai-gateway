# deepai-to-api

An OpenAI-compatible gateway in front of **DeepAI Code**. Sign in once with a
DeepAI account, mint `sk-` keys with their own limits, and point any OpenAI
client at `/v1`.

Comes with a dashboard: usage statistics, per-model breakdown, recent requests,
the model catalog, and API-key management.

## Quick start

```bash
npm install
npm start
```

Open <http://127.0.0.1:8787>, sign in with DeepAI, create a key, then:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

Any OpenAI SDK works:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sk-…
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address. Set `0.0.0.0` to expose on the network |
| `DATABASE` | `./data/deepai.db` | SQLite file |
| `LOG_REQUESTS` | `1` | Set `0` to silence per-request logging |
| `PRICING_CACHE` | `./data/pricing.json` | Where the fetched price table is cached |

## Per-user isolation

The dashboard is **per account**. A DeepAI login owns its keys and its traffic:

- `/api/keys`, `/api/usage/*`, `/api/account/events` and the export all filter by
  the signed-in username;
- another account's key answers `404`, not `403`, so its existence is not
  revealed;
- the 5-key cap is per account;
- with no session those endpoints answer `401` and the dashboard shows a
  **Log in required** prompt instead of empty tables.

A key cannot exist without an owner: creating one while logged out is refused
with `401 not_logged_in`. Usage rows carry `owner_username` themselves, so the
history stays attributable after the key that produced it is deleted.

## Dashboard

### Overview

- **Tokens this month** / **Tokens today** / **All time** / **Cache reads**
- **Money saved** — what the same traffic would cost on the public APIs these
  models mirror, in USD, for today / this month / all time, with a per-model
  breakdown
- **Token usage by model** — this month, busiest first. Models with no usage
  are not listed at all.
- **Recent requests** — newest first, failures included, with token split,
  duration and status.
- **Account card** — who is signed in, the Theos balance, and a low-balance
  warning.
- **14-day sparkline** of daily tokens.

### Models

Every catalog model with tier, context window, max output, reasoning levels,
input modalities, Theos rate and this month's usage. Free models are marked
`… Free`; **Premium** models draw on the Theos balance. (The provider calls
this tier "Premier" internally; the panel always says Premium.)

### Log in / log out

One control in the top bar: **Log in** while logged out, a filled red
**Log out** while logged in. Both act in the current tab — no popups.

### Theme

Light and dark, following the OS by default. An explicit choice from the top-bar
toggle is stored and takes precedence; with no stored choice the dashboard keeps
following the OS live.

### API Keys

The gateway allows **at most 5 keys**. Create keys with:

- **name**
- **limit window** — **Unlimited** (default, no cap at all), per hour, per day,
  per month, or total (never resets)
- **token limit** and **request limit** — shown only for a limited window
- **expiry** — **Never** (default) or a date; the date field only appears when
  a date is chosen
- **allowed models** — free models are preselected, with **Select free**,
  **All models** and **Clear** quick actions. *All models* is an unrestricted
  key that also covers models DeepAI adds later; *Clear* allows nothing.

The form hides anything that does not apply, so it only ever shows decisions
that matter.

Plus revoke, restore, edit and delete. Limits are enforced per key inside the
key's own window; a key over its limit gets HTTP 429. Every key records the
DeepAI account that owns it.

## Routing

Only `/` (and unknown page paths, so client-side routes survive a refresh)
serves the dashboard. `/v1/*` and `/api/*` always answer with JSON, never HTML,
so a client never receives a page it cannot parse.

## Persistence

Everything lives in one SQLite file (`data/deepai.db` by default, override with
`DATABASE`). Keys, **usage**, auth events and the account survive a restart —
including a hard `SIGKILL`, because SQLite's WAL is durable. Verified directly:
after `kill -9` and a restart, the key count, the usage rows and the savings
figure all come back unchanged.

Nothing in the codebase deletes usage. Deleting a key keeps its history: the
usage rows keep `key_name` and their `key_id` becomes `NULL`, so a removed key
does not erase what it spent.

On startup the server logs the database path, the number of stored keys and the
pricing source, so a persistence or pricing problem is visible in the log rather
than as a mysteriously empty dashboard. A graceful shutdown checkpoints the WAL
so a plain copy of the `.db` file is complete on its own.

### Exporting usage

`GET /api/usage/export` streams the history as CSV (default) or JSON, with
`?range=today|month|all` and `?keyId=` filters. Rows are streamed through a
SQLite iterator, so exporting a large history does not load it all into memory.
The dashboard's **Export CSV** button uses the same endpoint.

## How keys are stored

A key is shown **once**, at creation. Only a SHA-256 hash is persisted, so a
database leak does not hand out working credentials. Keys look like
`sk-` followed by 40 hex characters.

Each key also stores the **owner**: the DeepAI username and a hash of the
account key that was signed in when it was created. Usage rows keep the key
name, so deleting a key preserves its history.

Signing out clears the DeepAI account but **keeps the keys**, so their usage
stays attributable. Sign-in, sign-out, allowance refreshes and refused sign-ins
are appended to `auth_events`.

## Endpoints

### OpenAI surface

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/models` | Model list. **Requires a key**; scoped to what that key may use |
| `GET` | `/v1/models/details` | Richer catalog, same scoping |
| `POST` | `/v1/chat/completions` | Streaming and non-streaming, native tools |

`/v1/models` refuses an anonymous request with `401 missing_api_key`, and a
restricted key only ever sees the models it is allowed to call — so a client
cannot discover, or attempt, a model its key is not entitled to.

Each entry carries identity, capabilities and pricing, so a client never has to
hardcode them:

```json
{
  "id": "deepseek-v4.1-flash",
  "name": "DeepSeek V4.1 Flash",
  "display_name": "DeepSeek V4.1 Flash Free",
  "description": "Free tier · 1,048,576-token context · up to 131,072 output tokens",
  "tier": "free", "premier": false,
  "reasoning": true,
  "reasoning_levels": ["none", "low", "medium", "high"],
  "input_modalities": ["text", "image"],
  "output_modalities": ["text"],
  "context_window": 1048576,
  "max_output_tokens": 131072,
  "api": "openai-completions",
  "theos_per_second": { "none": "0", "low": "0", "medium": "0", "high": "0" },
  "rate_label": "Unmetered"
}
```

Supported request fields: `model`, `messages`, `stream`, `tools`, `tool_choice`,
`temperature`, `top_p`, `max_tokens` / `max_completion_tokens`,
`reasoning_effort` (`none` / `low` / `medium` / `high`), `stop`.

### Dashboard API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | The dashboard |
| `GET` | `/login` | Browser sign-in; redirects to DeepAI (`?json=1` returns the URL) |
| `GET` | `/auth-callback` | Where DeepAI sends the browser back — **on the panel's own port** |
| `GET` | `/logout` | Sign out, then redirect to `/` |
| `GET` | `/api/account` | Sign-in state, allowance, default model, key quota |
| `GET` | `/api/account/events` | That account's auth trail (login, logout, refresh, denied) |
| `POST` | `/api/login` · `/api/cancel-login` · `/api/logout` | DeepAI sign-in flow |
| `POST` | `/api/account/refresh` | Re-read the Theos balance |
| `GET` `POST` | `/api/keys` | List / create |
| `PATCH` `DELETE` | `/api/keys/:id` | Edit / delete |
| `POST` | `/api/keys/:id/revoke` · `/restore` | Toggle usability |
| `GET` | `/api/usage/summary` | Today / month / all-time totals, daily series, money saved |
| `GET` | `/api/usage/export` | Download the history (`?format=csv\|json`, `?range=`, `?keyId=`) |
| `GET` | `/api/pricing` | The live price table and its provenance |
| `POST` | `/api/pricing/refresh` | Force a refresh from OpenRouter |
| `GET` | `/api/usage/models` | Per-model breakdown (`?range=today\|month\|all`) |
| `GET` | `/api/usage/recent` | Recent requests (`?limit`, `?keyId`) |
| `GET` | `/api/usage/keys/:id` | One key's usage and history |
| `GET` | `/api/models` | Catalog with usage attached |
| `GET` | `/healthz` | Liveness + sign-in state |

## Money saved

The gateway is free to run, so the dashboard also shows what the same traffic
would have cost elsewhere. Each model is mapped to its public equivalent on
[OpenRouter](https://openrouter.ai/models) and priced with that model's
**live** published rates.

### Prices are fetched, not hard-coded

`src/pricing.js` pulls `GET https://openrouter.ai/api/v1/models`, keeps every
per-token rate the provider publishes, and caches the result to
`data/pricing.json`. The cache is refreshed every 6 hours in the background, and
the dashboard's **Refresh rates** button forces it on demand.

The bundled snapshot is used **only** until the first successful fetch, so a
fresh install still shows sensible numbers offline. If a refresh fails, the last
good table is kept — prices are never blanked by a network problem.

The DeepAI→OpenRouter id mapping is curated, because the catalogues spell the
same models differently (`mimo-2.6-flash` vs `xiaomi/mimo-v2.6-flash`,
`claude-opus-5-5` vs `anthropic/claude-opus-5.5`). A wrong guess would silently
price traffic against the wrong model. `deepai-cyber` has no public equivalent,
so it is mapped to `null`: its usage is counted and reported, but never priced.

### Cached tokens use the cache rate

Every token class is billed at its own published rate:

| Token class | Rate used |
| --- | --- |
| `inputTokens` | `prompt` |
| `cacheReadTokens` | `input_cache_read`, else `prompt` |
| `cacheWriteTokens` | `input_cache_write`, else `prompt` |
| `outputTokens` | `completion` |

Only when a rate is genuinely unpublished does the code fall back to the full
input rate, which overstates the cost rather than understating it. For
`claude-opus-5-5`, one million tokens of each class costs **$29.20** — input
$4, cache read $0.20, cache write $5, output $20.

The figures are a reference, not a quote: they assume identical token counts to
a real API call.

## Usage accounting

Every request appends exactly one row, and every dashboard reads from that same
table — totals, per-model breakdowns and the recent list cannot disagree.

Token counts are stored **disjoint**, matching OpenAI's own convention where
`prompt_tokens` includes cached input:

```
inputTokens = prompt_tokens − cacheReadTokens − cacheWriteTokens
totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
```

When the gateway reports usage back to its clients it re-inflates
`prompt_tokens` so a client's own accounting stays consistent.

## Performance

Streaming is a pass-through: deltas are forwarded as they arrive, and the
gateway adds roughly **0.6%** to the wall time of a long completion (measured
interleaved against a direct DeepAI connection: 108 ms of overhead across
~18 s and ~5,000 characters). The remaining latency is DeepAI's own.

Two details keep it that way:

- the SSE envelope is serialized once per request and reused for every delta,
  so only the delta object is stringified per chunk;
- `setNoDelay` is set on the response socket, so small writes are not held back
  by Nagle's algorithm.

Hot-path statements (key lookup, usage insert) are prepared once and reused,
and the SSE splitter uses `indexOf` rather than a regex — the regex was ~9×
slower on the same input.

## Design

The dashboard follows the **Geist** design language (Vercel): a monochrome
frame, 1px hairline structure instead of shadows, Inter with JetBrains Mono
micro-labels, and colour reserved for status. It has light and dark themes that
follow the OS by default, and a manual toggle.

## Architecture

```
server.js               Express wiring, static hosting, error shaping
src/db.js               SQLite schema and migrations (v2 audit, v3 per-user ownership)
src/keys.js             key generation, hashing, limit checks
src/usage.js            usage recording and every aggregate query
src/pricing.js          live OpenRouter prices, cache, and the savings estimate
src/store.js            account + settings persistence
src/openai.js           OpenAI ⇄ DeepAI conversions
src/middleware/auth.js  key authentication and limit enforcement
src/api/v1.js           /v1 OpenAI surface
src/api/admin.js        /api dashboard surface
src/deepai/catalog.js   model catalog with cache and offline snapshot
src/deepai/account.js   browser sign-in flow and allowance check
src/deepai/client.js    the two upstream transports
src/deepai/wire.js      shared headers, SSE parsing, usage normalization
public/                 dashboard (no framework, no build step)
```

Storage is SQLite through Node's built-in `node:sqlite` — no native build step
and no external database. The only runtime dependency is Express.

## DeepAI specifics

- Traffic goes to the same account-authenticated OpenAI-compatible API the
  official DeepAI Code desktop app uses, so **tool calls are native**.
- Models that declare `api: "openai-responses"` (`gpt-6-astra`) are routed to
  `/deepai_code/responses` and converted automatically.
- The model catalog is fetched from `GET /deepai_code/models` and cached for ten
  minutes; an embedded snapshot keeps the gateway usable offline.
- Login mirrors the desktop app, except the callback is served by the panel
  itself: DeepAI is told to call back on the port the gateway already listens
  on, so the flow needs no second listener and no extra firewall rule.
- **Login runs in the current tab**, not a popup. The panel navigates to DeepAI
  and DeepAI returns the browser to the panel, so there is no second window to
  close and no opener relationship to lose. The confirmation page hands the tab
  back on its own after a moment.
- The landing page follows the OS light/dark preference.

## Limits

- Text only. Image inputs are not forwarded.
- At most 5 gateway keys **per account**.
- The Responses route has no stop-sequence field, so `stop` is dropped for
  `gpt-6-astra`.
- Premier models require Theos balance on the DeepAI account; free models are
  unmetered.

## Tests

```bash
npm test
```

Runs offline against an in-memory database and a stubbed `fetch` — no account
and no network needed. Covers the schema and the v1→v2 migration, key
generation, ownership and limits, authentication, **per-user isolation** (keys,
usage, export and audit are scoped; ownerless keys are refused), usage
aggregation, live price parsing and cache accounting, usage export and
durability, both usage normalizers, the
catalog and the `/v1/models` payload, the OpenAI conversions, the `[hidden]`
and OS-theme CSS invariants,
routing (`/` is HTML, `/v1` and `/api` are JSON), the same-origin sign-in
callback, `/v1/models` scoping, the 5-key cap, the per-hour window, the SSE
splitter, and the Responses transport regression.
