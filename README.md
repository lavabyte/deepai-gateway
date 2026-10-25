# deepai-gateway

An OpenAI-compatible gateway in front of **DeepAI Code**. Log in with one or more
DeepAI accounts, mint `sk-` keys with their own limits, and point any OpenAI
client at `/v1`.

Comes with a dashboard: usage statistics, per-model breakdown, recent requests,
the model catalog, API-key management — and **real multi-user isolation**, so
several people can share one gateway without seeing each other's keys or traffic.

## Quick start

```bash
npm install
npm start
```

Open <http://127.0.0.1:8787>, log in with DeepAI, create a key, then:

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
| `TRUST_PROXY` | unset | Set `1` behind a TLS proxy: trust `X-Forwarded-*` and set `Secure` cookies |
| `PUBLIC_URL` | unset | The address visitors use, e.g. `https://gw.example.com`. Reported to the dashboard as your origin; it cannot change where DeepAI sends the browser (see [Signing in from another machine](#signing-in-from-another-machine)) |
| `LOG_REQUESTS` | `1` | Set `0` to silence per-request logging |
| `PRICING_CACHE` | `./data/pricing.json` | Where the fetched price table is cached |

## Multi-user

One gateway serves **many DeepAI accounts at once**. Each DeepAI login is a row in
`accounts`; each browser gets its own session cookie tied to one of them.

- **Accounts are separate.** Two people signed in on two browsers never see each
  other's keys, usage, auth trail or default model.
- **Keys belong to the account that made them.** A gateway key stores
  `owner_username`, and *that* account pays for the key's traffic — not whoever
  happens to be logged in when the request arrives.
- **Sessions are per browser.** Logging out ends only that browser's session. The
  account and its keys stay, so another signed-in browser keeps working and
  logging in again restores the same keys.
- **The 5-key cap is per account.**
- **Usage history outlives the key.** Rows carry `owner_username`, so deleting a
  key does not erase what it spent.

### What is public

Only what genuinely has to be:

| Endpoint | Access |
| --- | --- |
| `/healthz` | Public, and returns **only** `{"ok":true}` — a liveness probe must not become a directory of users |
| `/api/pricing` | Public: OpenRouter publishes these rates. The status is projected so upstream error detail stays internal |
| `/v1/models` | Requires an API key, scoped to what that key may use |
| `/api/models` | The catalog is public, the usage figures beside it are per account, so an identity is required: **a session cookie or one of your own `sk-` keys** |
| everything else under `/api` | Requires a session |
| `/api/pricing/refresh` | Requires a session: it performs an outbound network call |

Without a session those endpoints answer `401 not_logged_in`, and the dashboard
shows a **Log in required** prompt instead of empty tables. Creating a key without
a session is refused, so an ownerless key cannot exist.

### Concurrent logins

Login attempts are keyed per browser by a short-lived `deepai_gateway_login`
cookie. A single global slot would let a second visitor take over the first
visitor's pending login; with per-browser slots each attempt can only be
completed by the browser that started it.

### Behind a proxy

Set `TRUST_PROXY=1` when terminating TLS in front of the gateway. It enables
`X-Forwarded-*` handling and marks the session cookie `Secure`. Leave it off for
plain-HTTP localhost, where a `Secure` cookie would never be sent.

## Signing in from another machine

**DeepAI chooses the sign-in callback host, and it always chooses `127.0.0.1`.**
The gateway cannot override it:

- The sign-in request carries only `state` and `port`. DeepAI parses `port` as a
  plain TCP port — a full URL, a `host:port` pair, `0`, `-1` or an empty value are
  all rejected with `400 Invalid desktop sign-in request` — so there is no
  parameter through which a public origin could be passed.
- The sign-in page builds nothing client-side either: it polls
  `/daily-time-sync/user/` and reloads *itself*, leaving the redirect to DeepAI's
  server, which only ever learns a port number.

This is the RFC 8252 native-app pattern: the official DeepAI Code desktop app
binds `127.0.0.1:0`, hands over the ephemeral port, and expects the browser to
come back to loopback. `PUBLIC_URL` therefore changes what the dashboard *reports*
as your origin, never where DeepAI sends the browser.

The browser must run where `http://127.0.0.1:<port>` resolves to this gateway.
There are two ways to arrange that:

**1. Give the dead address a working host (works from anywhere).** After signing in
at DeepAI, the browser is sent to `http://127.0.0.1:<port>/auth-callback?code=…`
and shows a connection error. The sign-in is not lost — the code is still valid and
the address is still in the address bar. Both of these finish it:

- **Rewrite the host in the address bar.** Replace `127.0.0.1` with the host you
  are browsing from (e.g. `id-jkt01.altare.global:25912`) and press Enter. The
  gateway serves `/auth-callback` and `/callback` on its own origin, so this is the
  same request DeepAI meant to make, with the host it should have used — it lands
  on the real sign-in. No paste, nothing to install.
- **Paste the address into the dashboard.** Same result, for when copy-and-paste is
  easier than editing a URL. Which host the address names does not matter: only its
  `code` and `state` are read.

The dashboard does the explaining, so nobody has to know why the page failed:

- On a browser that is *not* on the gateway's own host, the sign-in card says up
  front that the last page may not load, and offers both routes above — naming the
  real host to substitute, and showing the address to look for.
- Once a sign-in is waiting, that becomes the only step on the card — **"One more
  step to finish"** — with the paste field already focused.
- On `127.0.0.1` the redirect just works, so nothing is said at all beyond a quiet
  *"Signed in on DeepAI already? Paste the address it sent you"* escape hatch.

Both paste routes go through the same validation: the gateway checks the address
against the sign-in that this browser started — only that browser can finish it, and
an address without a matching `state` is refused — then exchanges its code exactly
as the callback route would. A paste that is cut off says so in as many words
("missing its second half"), and costs one of five tries rather than the sign-in
itself.

The dashboard shows the exact address to expect, and the gateway logs it at boot
when `HOST` is not loopback.

**3. Sign in with an API key (simplest).** `POST /api/login/key` takes a DeepAI API
key and turns it into a session, with no callback, no address to copy and no
password. The dashboard offers it under **"Or paste a DeepAI API key"**. A key is
the same credential the sign-in exchange would have produced, so nothing is lost by
arriving with it directly — it is simply the shortest route when the gateway is
reached over the network.

The key is checked the same way a stored account is (`GET /deepai_code/theos`), so a
key that is refused says which kind of refusal it was:

| What DeepAI said | What the visitor is told |
| --- | --- |
| `theos` returns 401 and the public API does not recognise the key either | "DeepAI did not recognise that key" |
| `theos` returns 401 but the public model API *does* accept it | the key is valid but **not enabled for DeepAI Code** — which is what this gateway uses |
| anything else | DeepAI is unreachable; not the visitor's mistake |

That middle case is the likeliest failure of all, because `deepai.org` issues a key
for the public model API and it is not automatically enabled for DeepAI Code.

**Ownership is derived from the key, never typed by the visitor.** `api_keys.owner_username`
decides who sees and pays for a key, so a name the visitor could choose would let
them claim someone else's account. The owner is therefore
`key-<sha256(key)[0..16]>`: one-to-one with the key, non-reversible, and impossible
to point at another account. A test signs in with two keys and asserts that the
second cannot see the first's gateway keys.

**2. Forward the port.** Make the loopback address reach the gateway:

```sh
ssh -L 25912:127.0.0.1:8787 you@gateway-host
```

Then browse to `http://127.0.0.1:25912`, sign in, and the redirect resolves. The
port on the left must be the one DeepAI was given: the port visitors use, which
the gateway reads from the request (`PUBLIC_URL`, then `X-Forwarded-Host` when
`TRUST_PROXY=1`, otherwise `Host`).

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

### Revoking a key deletes it

**Revoke** is the one destructive action, and it removes the key:

- the key stops working immediately (`401` on its next request);
- its slot is freed, so a new key fits right away;
- its name becomes reusable;
- no tombstone is left behind.

Usage already recorded keeps its history: those rows carry `key_name`, and the
foreign key sets their `key_id` to `NULL`, so revoking does not erase what the key
spent.

Limits are enforced per key inside its own window; a key over its limit gets
HTTP 429. Every key records the DeepAI account that owns it.

## Routing

Only `/` (and unknown page paths, so client-side routes survive a refresh)
serves the dashboard. `/v1/*` and `/api/*` always answer with JSON, never HTML,
so a client never receives a page it cannot parse.

## Backups

```bash
npm run backup                      # -> backups/deepai-<timestamp>.db
npm run backup -- --out /mnt/x --keep 50
```

**Do not back up with `cp data/deepai.db`.** The database runs in WAL mode, so
recently committed rows live in `deepai.db-wal` until a checkpoint folds them in;
copying only the `.db` file silently captures stale state. This is not
theoretical — it happened during development: a key renamed in the live database
still appeared under its old name in such a copy.

The script uses `VACUUM INTO`, which writes a complete, checkpointed copy without
blocking writers, refuses to overwrite an existing file, and prints what the
backup actually holds (schema, accounts, keys, usage rows) so an empty or partial
copy is obvious rather than silent.

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

## How accounts and sessions are stored

- **`accounts`** — one row per DeepAI user: `username`, the DeepAI `api_key`, the
  cached Theos allowance, `is_pro`. Username is the identity, so signing in again
  replaces that row's key instead of adding a second row.
- **`sessions`** — one row per browser session. Only the **SHA-256 hash** of the
  token is stored, so a database dump does not hand out dashboard access. The
  cookie is `HttpOnly` and `SameSite=Lax`; it expires after 14 idle days.
- **`api_keys`** — as below, plus `owner_username` (which account pays) and
  `owner_key_hash` (the DeepAI key it was created with, kept as a record).
- **`auth_events`** — append-only login/logout/refresh/denied trail, per account.

## How keys are stored

A key is shown **once**, at creation. The row keeps only:

| Column | Contents | Purpose |
| --- | --- | --- |
| `prefix` | `sk-` + the first 8 hex characters | So the dashboard can show *which* key this is |
| `key_hash` | SHA-256 of the full key | Lookup at request time |

The plaintext key exists in the creation response and nowhere else — it is never
written to the database, never logged, and never returned by a later read. There
is no "show key again" button because the value is genuinely gone.

Verified against the raw database bytes: a `sk-…` value is absent from the file,
and neither the stored prefix nor the stored hash can be used as a key (both give
`401`). A stolen database therefore does not hand out working gateway keys.

Keys look like `sk-` followed by 40 hex characters.

The one credential that *is* stored recoverably is the **DeepAI account key**,
because it is what the gateway replays upstream on every request. It is the same
secret the DeepAI desktop app keeps on disk; protecting that file is what
protects the account.

Each key also stores its **owner**: the DeepAI username, and a hash of the
DeepAI key that was signed in when it was created. The owner — not the current
session — decides which account pays, so a key keeps billing the right account
even while its owner is logged out elsewhere.

Logging out keeps the account and its keys, so their usage stays attributable.
Only **Forget this account** removes them.

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
| `GET` | `/login` | Browser sign-in; redirects to DeepAI (`?json=1` returns the URL and the callback address) |
| `GET` | `/auth-callback` · `/callback` | Where DeepAI sends the browser back. The host is DeepAI's — always loopback — so see [Signing in from another machine](#signing-in-from-another-machine) |
| `POST` | `/api/login/complete` | Finish that sign-in from the dashboard by pasting the address the browser was sent to |
| `POST` | `/api/login/key` | Sign in directly with a DeepAI API key — no callback and no password |
| `GET` | `/logout` | Sign out, then redirect to `/` |
| `GET` | `/api/account` | This session's account, allowance, default model, key quota |
| `GET` | `/api/account/events` | That account's auth trail (login, logout, refresh, denied) |
| `POST` | `/api/account/forget` | Remove the account, its keys and its DeepAI credential |
| `POST` | `/api/login` · `/api/cancel-login` · `/api/logout` | DeepAI login flow |
| `POST` | `/api/account/refresh` | Re-read the Theos balance |
| `GET` `POST` | `/api/keys` | List / create |
| `PATCH` `DELETE` | `/api/keys/:id` | Edit / delete |
| `POST` | `/api/keys/:id/revoke` | Revoke a key: it is deleted |
| `GET` | `/api/usage/summary` | Today / month / all-time totals, daily series, money saved |
| `GET` | `/api/usage/export` | Download the history (`?format=csv\|json`, `?range=`, `?keyId=`) |
| `GET` | `/api/pricing` | The live price table and its provenance (public) |
| `POST` | `/api/pricing/refresh` | Force a refresh from OpenRouter (session required) |
| `GET` | `/api/usage/models` | Per-model breakdown (`?range=today\|month\|all`) |
| `GET` | `/api/usage/recent` | Recent requests (`?limit`, `?keyId`) |
| `GET` | `/api/usage/keys/:id` | One key's usage and history |
| `GET` | `/api/models` | Catalog with usage attached |
| `GET` | `/healthz` | Liveness only: `{"ok":true}` |

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
src/db.js               SQLite schema and migrations (v4: accounts + sessions, v5: revoke deletes)
src/keys.js             key generation, hashing, limit checks
src/usage.js            usage recording and every aggregate query
src/pricing.js          live OpenRouter prices, cache, and the savings estimate
src/store.js            account + settings persistence
src/openai.js           OpenAI ⇄ DeepAI conversions
src/middleware/auth.js  key authentication and limit enforcement
src/middleware/session.js  session cookie resolution, per browser
scripts/backup.js       WAL-safe database backup
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
  itself, so the flow needs no second listener. DeepAI still chooses the callback
  **host** — always `127.0.0.1` — so read
  [Signing in from another machine](#signing-in-from-another-machine) before
  exposing the panel.
- **Login runs in the current tab**, not a popup. The panel navigates to DeepAI
  and DeepAI returns the browser to the panel, so there is no second window to
  close and no opener relationship to lose. The confirmation page hands the tab
  back on its own after a moment.
- The landing page follows the OS light/dark preference.

## Limits

- Text only. Image inputs are not forwarded.
- At most 5 gateway keys per account.
- The dashboard has no password: authentication *is* the DeepAI login. Anyone
  who can reach the port and complete a DeepAI login gets their own account.
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
generation, ownership and limits, authentication, **multi-user isolation** (two
accounts on one gateway, cross-account reads refused, ownerless keys refused,
per-account settings), **sessions** (resolution, expiry, hashing, cookie
parsing, per-browser concurrent logins), usage aggregation, live price parsing
and cache accounting, usage export and durability, both usage normalizers, the
catalog and the `/v1/models` payload, the OpenAI conversions, the `[hidden]`
and OS-theme CSS invariants,
routing (`/` is HTML, `/v1` and `/api` are JSON), the same-origin sign-in
callback, `/v1/models` scoping, the 5-key cap, the per-hour window, the SSE
splitter, and the Responses transport regression.
