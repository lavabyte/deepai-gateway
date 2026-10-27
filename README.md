# deepai-gateway

An OpenAI-compatible gateway in front of **DeepAI Code**. Log in with one or more
DeepAI accounts, mint `sk-` keys with their own limits, and point any OpenAI
client at `/v1`.

Comes with a dashboard: usage statistics, per-model breakdown, recent requests,
the model catalog, API-key management - and **real multi-user isolation**, so
several people can share one gateway without seeing each other's keys or traffic.

## Quick start

```bash
git clone https://github.com/lavabyte/deepai-gateway.git
cd deepai-gateway
cp .env.example .env
npm install
npm start
```

That is the whole install. `.env` is optional - every value in it has a working default -
but copying it gives you the settings to edit, and `npm start` loads it for you.

To **update** an existing checkout:

```bash
git pull
npm install
```

`npm install` after a pull is worth running every time: if a dependency changed, this is
what picks it up.

Then open the dashboard:

```
http://<this-host>:8787
```

It listens on **every interface by default** (`HOST=0.0.0.0`), because a gateway is meant
to be reached from other machines. There is no dashboard password: access *is* the DeepAI
account you sign in with. On a public host, put it behind TLS and your own access control -
see [Signing in](#signing-in) and [Security](#security).

Sign in, create a key on the **API Keys** page, then point any OpenAI client at `/v1`:

```bash
curl http://<this-host>:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

```bash
export OPENAI_BASE_URL=http://<this-host>:8787/v1
export OPENAI_API_KEY=sk-...
```

## Configuration

Everything is optional. `.env.example` lists the same settings with the reasoning beside
each one; `npm start` reads `.env`, so nothing has to be exported in your shell.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address: every interface. Set `127.0.0.1` for this host only |
| `DATABASE` | `./data/deepai.db` | SQLite file |
| `TRUST_PROXY` | unset | Set `1` behind a TLS proxy: trust `X-Forwarded-*` and set `Secure` cookies |
| `CALLBACK_LOGIN` | `0` | Set `1` to also offer DeepAI's browser sign-in, finishing at `/callback` - see [Signing in with `/callback`](#signing-in-with-callback) |
| `FORGET_ACCOUNT_AFTER_DAYS` | `0` | Forget accounts nobody has used for this many days - see [Retention](#retention). `0` (the default) forgets nothing |
| `LOG_REQUESTS` | `1` | Set `0` to silence per-request logging |
| `PRICING_CACHE` | `./data/pricing.json` | Where the fetched price table is cached |

## Multi-user

One gateway serves **many DeepAI accounts at once**. Each DeepAI login is a row in
`accounts`; each browser gets its own session cookie tied to one of them.

- **Accounts are separate.** Two people signed in on two browsers never see each
  other's keys, usage, auth trail or default model.
- **Keys belong to the account that made them.** A gateway key stores
  `owner_username`, and *that* account pays for the key's traffic - not whoever
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
| `/healthz` | Public, and returns **only** `{"ok":true}` - a liveness probe must not become a directory of users |
| `/api/pricing` | Public: OpenRouter publishes these rates. The status is projected so upstream error detail stays internal |
| `/v1/models` | Requires an API key, scoped to what that key may use |
| `/api/models` | The catalog is public, the usage figures beside it are per account, so an identity is required: **a session cookie or one of your own `sk-` keys** |
| everything else under `/api` | Requires a session |
| `/api/pricing/refresh` | Requires a session: it performs an outbound network call |

Without a session those endpoints answer `401 not_logged_in`, and the dashboard
shows a **Log in required** prompt instead of empty tables. Creating a key without
a session is refused, so an ownerless key cannot exist.

### Behind a proxy

Set `TRUST_PROXY=1` when terminating TLS in front of the gateway. It enables
`X-Forwarded-*` handling and marks the session cookie `Secure`. Leave it off for
plain-HTTP localhost, where a `Secure` cookie would never be sent.

## Signing in

**DeepAI chooses the sign-in callback host, and it always chooses `127.0.0.1`.** That is
why this gateway does not use DeepAI's browser sign-in at all:

- The sign-in request carries only `state` and `port`. DeepAI parses `port` as a plain
  TCP port - a full URL, a `host:port` pair, `0`, `-1` or an empty value are all rejected
  with `400 Invalid desktop sign-in request` - so there is no parameter through which a
  public origin could be passed.
- The sign-in page builds nothing client-side either: it polls
  `/daily-time-sync/user/` and reloads *itself*, leaving the redirect to DeepAI's server,
  which only ever learns a port number.

This is the RFC 8252 native-app pattern: the official DeepAI Code desktop app binds
`127.0.0.1:0`, hands over the ephemeral port, and expects the browser to come back to
loopback. A browser on any other machine cannot open that address, and **no setting
changes it** - which is why there is no `PUBLIC_URL` and no relay to configure.

### Signing in with `/callback`

Off unless `CALLBACK_LOGIN` is set, because DeepAI fixes the redirect host to `127.0.0.1`:

```bash
CALLBACK_LOGIN=1 npm start
```

The dashboard then offers **Use DeepAI's sign-in page**, which navigates to DeepAI as usual
and comes back to `/callback` on this gateway. It completes only where that address reaches
the gateway, which in practice means:

- the browser runs on the gateway's own host, or
- the port is forwarded to it, so `127.0.0.1:<port>` in the browser is this gateway:

  ```sh
  ssh -L 25912:127.0.0.1:8787 you@gateway-host
  ```

  then browse to `http://127.0.0.1:25912` and sign in.

The port matters: DeepAI parses it as a plain integer, so the one it is given is the port
the browser must reach. Behind a proxy that is the internal port rather than the public one,
so use the forward from the browser's own machine.

If the last page does not load - the usual case when the address cannot be reached - the
card offers a field for pasting that page's address. The address is what authorises the
completion: it carries the one-shot `code` and the 256-bit `state` this gateway generated,
so a paste needs no session and nobody can finish somebody else's attempt.

`/auth-callback` is served as an alias of `/callback`, because earlier builds advertised
that path.

### The default route: copy the account JSON

The visitor signs in at `deepai.org` in their own browser - with a password, or with
Google or Apple - and then reads the account JSON out of DeepAI's own API:

1. Go to `https://deepai.org` and log in or register.
2. Go to `https://api.deepai.org/daily-time-sync/user/`, scroll down and choose the
   **Raw Data** tab. A browser asks for a JSON page and gets the account itself.
3. Copy the **Content** and paste it into the dashboard.

That JSON carries both the account's `email` and its `userprofile.api_key` - the account
key the Code lane accepts - so pressing **Log In** signs in with a key DeepAI has already
issued, and names the account from DeepAI's own answer rather than from anything typed.

It is the only route that works for a Google or Apple account without a tunnel: the page
is rendered for a session the visitor already has, so nothing is typed from memory and
nothing has to be trusted but the key, which DeepAI validates.

The hint about `OK` sits **between steps 1 and 2**, because it warns about what step 2
will show and is useless once step 2 has been read. The list is split into two so it can,
the second resuming at 2.

**If the page shows a plain `OK`, the visitor is not logged in.** The API answers `200`
with the account JSON and `201 OK` without one, so the dashboard says it in as few words
as it takes: *"If you get plain `OK` in step 2, make sure you are logged in."*

Two earlier versions of this instruction were worse, and both were taught by trying them:

- a browser-console command (`console.log(await (await fetch(...)).text())`) returns `'OK'`
  for anyone not already on DeepAI's own origin, because of the same `201`;
- the steps once sat behind a click, so the instructions a visitor needed were the ones
  they could not see.

There is no password form and no bare-key form. A DeepAI account created with Google or
Apple has no password to give, and a key pasted on its own cannot say whose account it is,
so three doors meant two of them were the wrong one for most visitors.

### What a refusal says

The key inside the pasted JSON is checked the same way a stored account is
(`GET /deepai_code/theos`), so a refusal says which kind it was:

| What DeepAI said | What the visitor is told |
| --- | --- |
| `credits` returns 401 and the public API does not recognise the key either | "DeepAI did not recognise that key" |
| `credits` returns 401 but the public model API *does* accept it | the key is valid but **not enabled for DeepAI Code** - which is what this gateway uses |
| anything else | DeepAI is unreachable; not the visitor's mistake |

That middle case is the likeliest failure of all, because `deepai.org` issues a key for
the public model API and it is not automatically enabled for DeepAI Code.

The paste itself is refused before any network call when it carries no key: `empty`,
`not-json`, `no-key` and `too-long` each say which part was wrong. A test asserts that
every reason either parser can return has a message, and that no message describes a
reason nothing can produce.

### Why ownership does not come from the pasted email

The email is taken from DeepAI's own JSON, so it is fact rather than a claim - but it is
still only a **label**, and ownership is derived from the key:

`api_keys.owner_username` decides who sees and pays for a key, so an owner the visitor
could choose would let them claim someone else's account. The owner is therefore
`key-<sha256(key)[0..16]>`: one-to-one with the key, non-reversible, and impossible to
point at another account. The email is stored as a per-account `display_name` setting, and
the dashboard shows it in place of that fingerprint.

**A key already known to the gateway keeps its account.** DeepAI mints a fresh key on
every sign-in, so one DeepAI account can hold several, and the same key can arrive twice.
Matching on the key keeps that on one owner instead of splitting the account, its keys and
its usage across two identities that look unrelated in the dashboard.

### Why a key alone cannot be asked who it belongs to

No request makes a DeepAI key reveal its account - which is why the JSON route reads the
email from DeepAI's page rather than trying to derive it:

| Attempt | Result |
| --- | --- |
| `GET /deepai_code/theos`, `GET /get_usage_summary` with the key | allowance only, no identity |
| `GET /daily-time-sync/user/` - the endpoint DeepAI's own sign-in page uses to ask "who am I" - with the key | answers **201**, not 200, which that page reads as "not signed in" |
| `POST /deepai_code/desktop_auth/exchange/` with a key instead of a code | `400 invalid code` |

## Security

What protects what, including the parts that are deliberately not protected.

| Asset | How it is protected |
| --- | --- |
| Gateway keys (`sk-...`) | Only `sk-` + the first 8 hex characters and a **SHA-256 hash** are stored. The plaintext exists once, in the creation response. A stolen database does not yield a working gateway key. |
| Dashboard session | A 32-byte random token; only its hash is stored. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `TRUST_PROXY=1`. It slides: it ends after 14 days of *idle* time. |
| Accounts and usage | Every query is scoped to the session's account. Another account's key id answers `404`, and its usage reads empty - asserted by tests. |
| The DeepAI key | **Stored recoverably**, because it is replayed upstream on every request. The database and its WAL are created owner-only (`0600`), the directory `0700`, and `npm run backup` writes `0600`. On a shared machine, that file *is* the account. |
| SQL | Every statement is parameterised. The only interpolated fragments are fixed strings. |

**There is no dashboard password.** Access *is* the DeepAI account, proven by a key only
DeepAI could have issued. That is the whole authentication model, so:

- **`HOST` defaults to `0.0.0.0`**, which makes the dashboard reachable by anyone who can
  reach the port. Set `HOST=127.0.0.1` to keep it local, and put TLS and your own access
  control in front of anything public.
- **The pasted account JSON is kept in the browser.** Signing in that way means fetching
that JSON by hand, so the last one is saved to `localStorage` and the field is filled with
it next time, including after signing out. It contains the account's **API key**, so it is
readable by any script on this origin and by anyone who opens that browser profile: the
sign-in card says so, offers **Clear it**, and **Forget this account** removes it. Use
**Clear it** on a shared machine, and prefer a private window on one you do not control.

**The sign-in route is unauthenticated and unthrottled** - it has to be, since it *is* the
  way in - and a valid-looking paste makes the gateway issue up to three requests to DeepAI.
  Put a rate limiter in front of `/api/login/profile` (and `/callback` when enabled) if the
  gateway is exposed.
- **Per-key limits are a check-then-act**, so a key can exceed its cap by sending concurrent
  requests. Treat a key's limit as a guard against accidents, not against an adversary.

Report a security problem by opening an issue, or privately if the repository offers it.

## Dashboard

### Overview

- **Tokens this month** / **Tokens today** / **All time** / **Cache reads**
- **Money saved** - what the same traffic would cost on the public APIs these
  models mirror, in USD, for today / this month / all time, with a per-model
  breakdown
- **Token usage by model** - this month, busiest first. Models with no usage
  are not listed at all.
- **Recent requests** - newest first, failures included, with token split,
  duration and status.
- **Account card** - who is signed in, the Credits balance, and a low-balance
  warning.
- **14-day sparkline** of daily tokens.

### Models

Every catalog model with tier, context window, max output, reasoning levels,
input modalities, Credits rate and this month's usage. Free models are marked
`... Free`; **Premium** models draw on the Credits balance. (The provider calls
this tier "Premier" internally; the panel always says Premium.)

### Log in / log out

The top bar carries the account badge and the theme toggle, nothing else. A signed-out
visitor needs no button: the overview *is* the sign-in form. **Log out** sits in the
account card beside **Refresh balance** and **Forget this account**, because ending a
session is an account action like the others.

Logging out ends this browser's session only. The DeepAI account and its keys stay, so
another signed-in browser keeps working and signing in again restores the same keys.

### Languages

The dashboard speaks **English, Polish, German, Spanish and Hindi**. The switcher sits at the
right of the top bar, next to the theme toggle, and shows the active language as a flag;
opening it lists every language by flag and by its own name.

The strings live as JSON in `public/locales/<code>.json`, so a translation is a data
change and never a code change. `en.json` is the complete set and the fallback: a key
missing from another language renders as English rather than as an empty space, and a key
missing everywhere renders as the key itself, which makes the gap visible instead of
silent.

There is no language in the URL and nothing is stored on the server: the choice is kept in
`localStorage`, and with nothing stored the browser's own preference decides, so a Polish
visitor gets Polish without touching anything.

A phrase whose wording depends on a number is stored as an object of plural forms rather
than as one string, and the form is chosen by `Intl.PluralRules` for the active language -
not by comparing the count. That matters because the rules differ: English has two forms
and Polish has four, so the same key is `{one, other}` in `en.json` and
`{one, few, many, other}` in `pl.json`. Without it, Polish shows "1 żądań" instead of
"1 żądanie". Numbers are formatted per language too, so a German reader sees `1.234`. Hindi
needs no plural objects at all, because its nouns do not change with the count, so those
keys are plain strings there.

Hindi also brings a character the other four do not use: the danda (`।`) that ends a
sentence. It is kept for the same reason as the Spanish inverted question mark - there is
no plain equivalent, and dropping it is a spelling mistake rather than a style choice - and
the character test allows it by name.

The translations are guarded by a test that checks every language against `en.json` for
the same key set, no empty values, the same `{placeholders}` and `<tags>` per key, and an
`other` form on every plural entry - a translation that drops `{source}` renders a
sentence with a hole in it, which no runtime error would ever report.

To add a language: add its entry to `LOCALES` in `public/app.js`, drop its JSON in
`public/locales/`, and the test will hold it to the same standard as the others.

### Currency

The picker to the right of the language one shows a currency sign: `$`, `€`, `£`, `zł`,
`₹`, `¥` and six more. It changes how amounts are **shown**, nothing else.

**The gateway deals only in US dollars.** That is the unit the OpenRouter price table is
published in, and there is no currency field anywhere in the API: a row's cost is a number
of dollars, and storing a converted figure would make the same row mean something different
depending on when it was written. The tests hold the server to that - no currency code and
no rate feed appears in `src/`.

The conversion is the browser's, and so is the rate:

- **Source:** Frankfurter (`api.frankfurter.dev`), which republishes the European Central
  Bank's reference rates. No key, no account, no quota, and it sends
  `Access-Control-Allow-Origin: *`, so the fetch goes straight from the page and nothing is
  proxied through the gateway or logged by it.
- **Caching:** one set per working day, so today's copy is stored in `localStorage` with its
  date and reused. A copy from an earlier day is refetched rather than trusted. USD needs no
  rate and never contacts the feed.
- **Failure is visible, not silent:** without a rate the figures stay in the US dollars the
  server sent and the card says so. A converted number the reader cannot check would be
  worse than the one the gateway actually reported.
- **The ECB rate of which day** is printed under the figures, so a number can be traced.

Credits are not money and are not converted: they are DeepAI's own unit for what its models
consume, alongside the dollar figures that come from the price table.

### Theme

Light and dark, following the OS by default. An explicit choice from the top-bar
toggle is stored and takes precedence; with no stored choice the dashboard keeps
following the OS live.

### API Keys

The gateway allows **at most 5 keys**. Create keys with:

- **name**
- **limit window** - **Unlimited** (default, no cap at all), per hour, per day,
  per month, or total (never resets)
- **token limit** and **request limit** - shown only for a limited window
- **expiry** - **Never** (default) or a date; the date field only appears when
  a date is chosen
- **allowed models** - free models are preselected, with **Select free**,
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

## Retention

`FORGET_ACCOUNT_AFTER_DAYS` asks the gateway to forget accounts nobody has used for a
while. It is **off by default**: `0`, unset, or anything that is not a positive whole
number removes nothing, so a deployment has to opt in on purpose.

```bash
FORGET_ACCOUNT_AFTER_DAYS=30 npm start
```

**"Used" means either kind of activity**, which is why the account carries a
`last_seen_at` column rather than reusing `updated_at`:

- a dashboard request through a session, or
- traffic through one of the account's gateway keys.

`updated_at` could not serve, because the background allowance refresh writes it - an
abandoned account would have looked busy forever. The timestamp is written at most once an
hour per account, so activity costs almost nothing.

Forgetting is the same operation as **Forget this account**: the account, its DeepAI
credential and its gateway keys are removed. **Usage history is kept** - those rows carry
`key_name`, and they are what a bill or an audit is read from. The sweep runs at startup
and then once a day, so a gateway that stays up for months still forgets; the log names
every account it removes and how long it had been idle.

```text
[deepai-gateway] forgot stale-account: unused for 45 days (limit 30), 2 key(s) deleted
[deepai-gateway] retention sweep (startup): 1 account(s) forgotten, usage history kept
```

## Backups

```bash
npm run backup                      # -> backups/deepai-<timestamp>.db
npm run backup -- --out /mnt/x --keep 50
```

**Do not back up with `cp data/deepai.db`.** The database runs in WAL mode, so
recently committed rows live in `deepai.db-wal` until a checkpoint folds them in;
copying only the `.db` file silently captures stale state. This is not
theoretical - it happened during development: a key renamed in the live database
still appeared under its old name in such a copy.

The script uses `VACUUM INTO`, which writes a complete, checkpointed copy without
blocking writers, refuses to overwrite an existing file, and prints what the
backup actually holds (schema, accounts, keys, usage rows) so an empty or partial
copy is obvious rather than silent.

## Persistence

Everything lives in one SQLite file (`data/deepai.db` by default, override with
`DATABASE`). Keys, **usage**, auth events and the account survive a restart -
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

- **`accounts`** - one row per DeepAI user: `username`, the DeepAI `api_key`, the
  cached Credits allowance, `is_pro`, and `last_seen_at` (the last time the account was
  used, for [retention](#retention)). Username is the identity, so signing in again
  replaces that row's key instead of adding a second row.
- **`sessions`** - one row per browser session. Only the **SHA-256 hash** of the
  token is stored, so a database dump does not hand out dashboard access. The
  cookie is `HttpOnly` and `SameSite=Lax`; it expires after 14 idle days.
- **`api_keys`** - as below, plus `owner_username` (which account pays) and
  `owner_key_hash` (the DeepAI key it was created with, kept as a record).
- **`auth_events`** - append-only login/logout/refresh/denied trail, per account.

## How keys are stored

A key is shown **once**, at creation. The row keeps only:

| Column | Contents | Purpose |
| --- | --- | --- |
| `prefix` | `sk-` + the first 8 hex characters | So the dashboard can show *which* key this is |
| `key_hash` | SHA-256 of the full key | Lookup at request time |

The plaintext key exists in the creation response and nowhere else - it is never
written to the database, never logged, and never returned by a later read. There
is no "show key again" button because the value is genuinely gone.

Verified against the raw database bytes: a `sk-...` value is absent from the file,
and neither the stored prefix nor the stored hash can be used as a key (both give
`401`). A stolen database therefore does not hand out working gateway keys.

Keys look like `sk-` followed by 40 hex characters.

The one credential that *is* stored recoverably is the **DeepAI account key**,
because it is what the gateway replays upstream on every request. It is the same
secret the DeepAI desktop app keeps on disk; protecting that file is what
protects the account.

Each key also stores its **owner**: the DeepAI username, and a hash of the
DeepAI key that was signed in when it was created. The owner - not the current
session - decides which account pays, so a key keeps billing the right account
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
restricted key only ever sees the models it is allowed to call - so a client
cannot discover, or attempt, a model its key is not entitled to.

Each entry carries identity, capabilities and pricing, so a client never has to
hardcode them:

```json
{
  "id": "deepseek-v4.1-flash",
  "name": "DeepSeek V4.1 Flash",
  "display_name": "DeepSeek V4.1 Flash Free",
  "description": "Free tier - 1,048,576-token context - up to 131,072 output tokens",
  "tier": "free", "premier": false,
  "reasoning": true,
  "reasoning_levels": ["none", "low", "medium", "high"],
  "input_modalities": ["text", "image"],
  "output_modalities": ["text"],
  "context_window": 1048576,
  "max_output_tokens": 131072,
  "api": "openai-completions",
  "credits_per_second": { "none": "0", "low": "0", "medium": "0", "high": "0" },
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
| `POST` | `/api/login/profile` | The only way in: the account JSON copied out of the visitor's own browser - see [Signing in](#signing-in) |
| `GET` | `/logout` | Sign out, then redirect to `/` |
| `GET` | `/api/account` | This session's account, allowance, default model, key quota |
| `GET` | `/api/account/events` | That account's auth trail (login, logout, refresh, denied) |
| `POST` | `/api/account/forget` | Remove the account, its keys and its DeepAI credential |
| `POST` | `/api/account/refresh` | Re-read the Credits balance |
| `GET` `POST` | `/api/keys` | List / create |
| `PATCH` | `/api/keys/:id` | Edit a key's name, limits, expiry or allowed models |
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
good table is kept - prices are never blanked by a network problem.

The DeepAI->OpenRouter id mapping is curated, because the catalogues spell the
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
`claude-opus-5-5`, one million tokens of each class costs **$29.20** - input
$4, cache read $0.20, cache write $5, output $20.

The figures are a reference, not a quote: they assume identical token counts to
a real API call.

## Usage accounting

Every request appends exactly one row, and every dashboard reads from that same
table - totals, per-model breakdowns and the recent list cannot disagree.

Token counts are stored **disjoint**, matching OpenAI's own convention where
`prompt_tokens` includes cached input:

```
inputTokens = prompt_tokens - cacheReadTokens - cacheWriteTokens
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
and the SSE splitter uses `indexOf` rather than a regex - the regex was ~9x
slower on the same input.

## Design

The dashboard follows the **Geist** design language (Vercel): a monochrome
frame, 1px hairline structure instead of shadows, Inter with JetBrains Mono
micro-labels, and colour reserved for status. It has light and dark themes that
follow the OS by default, and a manual toggle.

### Deploys and the browser cache

The dashboard shell (`index.html`) is served `Cache-Control: no-store` and names its
scripts and styles with a version taken from their own bytes
(`/app.js?v=<sha256 prefix>`). A deploy therefore changes the URL, so a browser cannot
keep an old screen after new code ships.

If you ever change an asset's URL by hand, keep the pattern - an unversioned
reference reintroduces the problem this solves.

There is a second, related trap worth knowing: there are **two** signed-out screens -
the log-in screen and the account card on the overview - and they used to carry their
own copies of the sign-in markup. Rewriting the form therefore changed only one of them,
and the overview kept a control that existed nowhere else. They now render the same block
through one function, and a test renders both and requires the same fields in each, so a
third screen added later cannot quietly diverge.

### Copying to the clipboard

`navigator.clipboard` is exposed only in a **secure context** - HTTPS, or localhost. A
gateway reached at `http://some-host:port` therefore has no `navigator.clipboard` at all,
and the modern call fails silently: that is why copying an API key used to do nothing on a
plain-HTTP deployment. `copy()` falls back to the pre-Clipboard-API technique, which works
without a secure context because it drives the browser's own copy command on a selected
field; if even that is refused, the text is left selected and the toast says to press
Ctrl/Cmd+C, so a failed copy never leaves a key the visitor cannot take away.

### Confirmation dialogs

Destructive actions confirm in the app's own modal, never with `window.confirm` or
`window.alert`. A browser dialog blocks the page, cannot be styled, is drawn by the
browser rather than by this interface, and on some platforms can be suppressed - which
would drop the guard on the very actions that need one. `confirmAction()` reuses the modal
the key editor opens, so Escape, the backdrop and focus behave the same, the destructive
button is styled as such and is never the default, and a test renders it and asserts both
answers are present.

### Brand marks

`assets/app-icon-512.png` and `assets/app-icon-512-black.png` are the source artwork: one glyph in
white and black, on a transparent background. Because each disappears against the
opposite background, the visible one is chosen per theme:

| Where | How it adapts |
| --- | --- |
| Header logo | two `<img>` elements, one shown by `html[data-theme]` in CSS - a logo that waits for JavaScript is a logo that can be missing |
| Favicon (`public/icon-32.png`, `public/icon-black-32.png`) | set from JavaScript, because a stylesheet cannot reach a favicon; `index.html` decides it before the first paint so the tab never shows the wrong mark |
| `/favicon.ico` | a 16/32/48 fallback for clients that ask for it by convention |

`public/icon.png` and `public/icon-black.png` are the full-size copies the pages
serve; the favicons are generated from the same artwork, trimmed and re-padded so the
glyph still reads at 32px.

## Architecture

```
server.js               Express wiring, static hosting, error shaping
src/db.js               SQLite schema and migrations (v4: accounts + sessions, v5: revoke deletes, v6: last_seen_at)
src/keys.js             key generation, hashing, limit checks
src/usage.js            usage recording and every aggregate query
src/pricing.js          live OpenRouter prices, cache, and the savings estimate
src/store.js            account + settings persistence
src/openai.js           OpenAI <-> DeepAI conversions
src/middleware/auth.js  key authentication and limit enforcement
src/middleware/session.js  session cookie resolution, per browser
scripts/backup.js       WAL-safe database backup
src/api/v1.js           /v1 OpenAI surface
src/api/admin.js        /api dashboard surface
src/deepai/catalog.js   model catalog with cache and offline snapshot
src/deepai/account.js   key check, owner derivation, account-JSON parsing
src/deepai/client.js    the two upstream transports
src/deepai/wire.js      shared headers, SSE parsing, usage normalization
public/                 dashboard (no framework, no build step)
public/locales/         UI strings, one JSON per language (en is the fallback)
```

Storage is SQLite through Node's built-in `node:sqlite` - no native build step
and no external database. The only runtime dependency is Express.

## DeepAI specifics

- Traffic goes to the same account-authenticated OpenAI-compatible API the
  official DeepAI Code desktop app uses, so **tool calls are native**.
- Models that declare `api: "openai-responses"` (`gpt-6-astra`) are routed to
  `/deepai_code/responses` and converted automatically.
- The model catalog is fetched from `GET /deepai_code/models` and cached for ten
  minutes; an embedded snapshot keeps the gateway usable offline.
- DeepAI's browser sign-in is **not** used: it always calls back to `127.0.0.1`, which
  no setting can move. Sign-in is the account JSON copied out of DeepAI's own API page -
  see [Signing in](#signing-in).

## Limits

- Text only. Image inputs are not forwarded.
- At most 5 gateway keys per account.
- The dashboard has no password of its own: authentication *is* the DeepAI account,
  proven by a key only DeepAI could have issued. Anyone who can reach the port and
  paste their own account JSON gets their own account, isolated from the others.
- The Responses route has no stop-sequence field, so `stop` is dropped for
  `gpt-6-astra`.
- Premier models require Credits balance on the DeepAI account; free models are
  unmetered.

## Tests

```bash
npm test
```

Runs offline against an in-memory database and a stubbed `fetch` - no account
and no network needed. Covers the schema and the v1->v5 migrations, key
generation, ownership and limits, authentication, **multi-user isolation** (two
accounts on one gateway, cross-account reads refused, ownerless keys refused,
per-account settings), **sessions** (resolution, expiry, hashing, cookie
parsing), usage aggregation, live price parsing and cache accounting, usage
export and durability, both usage normalizers, the catalog and the `/v1/models`
payload, the OpenAI conversions, the `[hidden]` and OS-theme CSS invariants,
routing (`/` is HTML, `/v1` and `/api` are JSON), the removal of the browser
sign-in routes, the sign-in card's one route and its copyable instructions,
`/v1/models` scoping, the 5-key cap, the per-hour window, the SSE splitter, and
the Responses transport regression.

A few checks are guards rather than descriptions: the stylesheet may carry no class or
custom property with no reader, no client code may call `window.confirm`, and the
sign-in card's command must survive rendering unescaped - each verified by breaking it
on purpose and watching the check fail.
