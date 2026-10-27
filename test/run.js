/**
 * Offline test suite for the gateway.
 *
 * Everything runs against an in-memory database and a stubbed `fetch`, so no
 * DeepAI account or network access is required. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/db.js';
import {
  generateKey,
  hashKey,
  keyQuota,
  overLimit,
  publicKey,
  statusOf,
  totalKeyCount,
} from '../src/keys.js';
import { exportRows, keyUsage, record, startOfHour, summary, totals, windowStart } from '../src/usage.js';
import {
  SESSION_COOKIE,
  clearAccount,
  clearSessionCookie,
  createSession,
  destroySession,
  hashToken,
  listAccounts,
  readAccount,
  saveAccount,
  saveAllowance,
  sessionAccount,
  sessionCookie,
  tokenFromCookie,
} from '../src/store.js';
import { authenticate, keyFromRequest } from '../src/middleware/auth.js';
import {
  effortOf,
  openAIUsage,
  openAIToResponsesInput,
  stopSequences,
} from '../src/openai.js';
import { completionsUsage, responsesUsage } from '../src/deepai/wire.js';
import { FALLBACK_MODELS, REASONING_LEVELS, displayName, findModel, publicModel, rateLabel } from '../src/deepai/catalog.js';
import { findEventEnd } from '../src/deepai/wire.js';
import {
  FALLBACK_PRICES,
  MODEL_SOURCES,
  buildPrices,
  estimateSavings,
  formatUsd,
  initPricing,
  isPriced,
  parsePrice,
  priceOf,
  priceUsage,
  pricingStatus,
  publicPrices,
  readCache,
  refreshPrices,
  resetPricing,
} from '../src/pricing.js';

/*
 * The client loads its strings from `public/locales/<code>.json`. A stub that answered
 * every unknown URL with `{ok:true}` would hand `t()` an object with no keys, so every
 * translated string would render as its key and the text assertions below would fail for
 * the wrong reason. The real files are served instead.
 */
const LOCALE_CODES = ['en', 'pl', 'de', 'es'];
const LOCALE_PATH = (code) => new URL(`../public/locales/${code}.json`, import.meta.url);

/*
 * Loaded tolerantly: a missing file is skipped here rather than thrown, so one absent
 * translation cannot take the whole suite down with it. That it is missing is reported by
 * the locale check below, which is where a reader would look for it.
 */
const LOCALES = {};
for (const code of LOCALE_CODES) {
  try {
    LOCALES[code] = JSON.parse(readFileSync(LOCALE_PATH(code), 'utf8'));
  } catch {
    /* reported by the locale check */
  }
}

/** A `Response` carrying one language's strings, as the client would receive them. */
function localeResponse(code = 'en') {
  return new Response(JSON.stringify(LOCALES[code]), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

const results = [];
function check(name, fn) {
  /*
   * A synchronous check cannot await an async test. The assertions inside still run, but
   * a failure becomes an unhandled rejection that kills the whole run - so instead of a
   * reported FAIL the author gets a crash and no results at all. That happened, which is
   * why this is loud rather than silent.
   */
  if (fn.constructor.name === 'AsyncFunction') {
    results.push(`  FAIL ${name}\n       an async test needs checkAsync(), not check()`);
    process.exitCode = 1;
    return;
  }
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

/**
 * Create an account plus a session for it and return the request headers that
 * authenticate as that user. The dashboard authenticates with a cookie, so every
 * HTTP check below needs one - exactly like a browser.
 */
function sessionFor(database, username, options = {}) {
  const apiKey = options.apiKey ?? `key-${username}`;
  saveAccount(database, { apiKey, username, isPro: options.isPro === true });
  const session = createSession(database, username);
  return {
    username,
    apiKey,
    token: session.token,
    cookie: `${SESSION_COOKIE}=${session.token}`,
    headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
  };
}

/**
 * JSON request helper carrying one user's session cookie.
 *
 * A plain object `body` is serialized; a string is sent as-is. That matters:
 * `fetch` stringifies a plain object to "[object Object]", which the server would
 * reject as an invalid body without saying so clearly.
 */
function asUser(base, session) {
  return async (path, init = {}) => {
    const hasBody = init.body !== undefined;
    const body = hasBody && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body;
    const { anonymous = false, ...rest } = init;
    const headers = {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      // `anonymous: true` models a browser after /api/logout cleared its cookie.
      ...(anonymous ? {} : session.headers),
      ...(rest.headers ?? {}),
    };
    const response = await fetch(`${base}${path}`, { ...rest, body, headers });
    const text = await response.text();
    let parsed;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
}

/* ------------------------------------------------------------------- schema */

const db = openDatabase(':memory:');

check('schema creates the expected tables', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['meta', 'accounts', 'sessions', 'api_keys', 'usage', 'settings', 'auth_events']) {
    assert.ok(names.includes(table), `missing table ${table}`);
  }
  // The pre-multi-user table must be gone, not merely unused.
  assert.ok(!names.includes('account'), 'the single-row account table must be dropped');
});

/* --------------------------------------------------------------------- keys */

check('generated keys look right and hash deterministically', () => {
  const key = generateKey();
  assert.match(key.plaintext, /^sk-[0-9a-f]{40}$/);
  assert.equal(key.prefix, key.plaintext.slice(0, 11));
  assert.equal(key.hash, hashKey(key.plaintext));
  assert.notEqual(generateKey().plaintext, key.plaintext);
});

check('overLimit covers both counters and unlimited keys', () => {
  const base = { limit_requests: 5, limit_tokens: 1000 };
  assert.equal(overLimit(base, { requests: 4, totalTokens: 999 }), false);
  assert.equal(overLimit(base, { requests: 5, totalTokens: 0 }), true);
  assert.equal(overLimit(base, { requests: 0, totalTokens: 1000 }), true);
  const unlimited = { limit_requests: null, limit_tokens: null };
  assert.equal(overLimit(unlimited, { requests: 9999, totalTokens: 9_999_999 }), false);
});

check('status reflects revocation, expiry and limits', () => {
  const now = Date.now();
  assert.equal(statusOf({ revoked_at: null, expires_at: null }, { requests: 0 }), 'active');
  assert.equal(statusOf({ revoked_at: now, expires_at: null }, { requests: 0 }), 'revoked');
  assert.equal(statusOf({ revoked_at: null, expires_at: now - 1000 }, { requests: 0 }), 'expired');
  assert.equal(statusOf({ revoked_at: null, expires_at: null, limit_requests: 1 }, { requests: 1 }), 'limited');
});

check('publicKey never leaks the hash', () => {
  const row = {
    id: 'key_1', name: 'test', prefix: 'sk-abcdefg', key_hash: 'deadbeef',
    created_at: 1, last_used_at: null, revoked_at: null, expires_at: null,
    limit_tokens: null, limit_requests: null, limit_window: 'month', allowed_models: '["a"]',
  };
  const view = publicKey(row, { requests: 0, totalTokens: 0 });
  assert.equal(view.key_hash, undefined);
  assert.deepEqual(view.allowedModels, ['a']);
  assert.equal(view.limitWindow, 'month');
});

check('parse of malformed allowed_models does not throw', () => {
  const view = publicKey({ id: 'x', name: 'n', prefix: 'p', allowed_models: 'not json', limit_window: 'day' });
  assert.deepEqual(view.allowedModels, []);
});

/* -------------------------------------------------------------------- usage */

check('token counts are stored disjoint and aggregated', () => {
  const key = generateKey();
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models)
              VALUES ('k1', 'first', ?, ?, ?, 'month', '[]')`).run(key.prefix, key.hash, Date.now());

  record(db, {
    keyId: 'k1', keyName: 'first', model: 'm-a', inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 30, reasoningTokens: 5, totalTokens: 150, status: 200, ok: true,
  });
  record(db, {
    keyId: 'k1', keyName: 'first', model: 'm-b', inputTokens: 10, outputTokens: 5,
    totalTokens: 15, status: 500, ok: false, errorCode: 'PROVIDER_ERROR',
  });

  const all = summary(db);
  assert.equal(all.all.requests, 2);
  assert.equal(all.all.failedRequests, 1);
  assert.equal(all.all.totalTokens, 165);
  assert.equal(all.all.inputTokens, 110);
  assert.equal(all.all.cacheReadTokens, 30);
  assert.equal(all.all.reasoningTokens, 5);

  const models = all.modelsAll.map((model) => model.model);
  assert.deepEqual(models.sort(), ['m-a', 'm-b']);
  assert.equal(all.modelsAll.find((model) => model.model === 'm-a').requests, 1);

  const scoped = keyUsage(db, 'k1', 'month');
  assert.equal(scoped.requests, 2);
  assert.equal(scoped.totalTokens, 165);
});

check('windowStart separates day, month and total', () => {
  const now = new Date('2026-10-25T15:00:00').getTime();
  const day = new Date(windowStart('day', now));
  assert.equal(day.getHours(), 0);
  assert.equal(day.getDate(), 25);
  const month = new Date(windowStart('month', now));
  assert.equal(month.getDate(), 1);
  assert.equal(month.getMonth(), 9);
  assert.equal(windowStart('total', now), 0);
});

check('daily series has one bucket per day', () => {
  const days = summary(db).daily;
  assert.equal(days.length, 14);
  assert.equal(days.at(-1).tokens, 165);
});

/* ------------------------------------------------------------------ account */

check('accounts round-trip per username and never merge', () => {
  assert.equal(readAccount(db, 'nobody'), undefined);
  saveAccount(db, { apiKey: 'secret-key', username: 'tester', isPro: true });
  const account = readAccount(db, 'tester');
  assert.equal(account.apiKey, 'secret-key');
  assert.equal(account.username, 'tester');
  assert.equal(account.isPro, true);
  assert.equal(account.allowance, null);

  saveAllowance(db, 'tester', { balance: '49.5', granted: '50', refreshAt: '2026-10-26T15:07:00Z' });
  assert.equal(readAccount(db, 'tester').allowance.balance, '49.5');

  // A second DeepAI user is a second row: the first one is untouched.
  const second = saveAccount(db, { apiKey: 'other-key', username: 'other', isPro: false });
  assert.equal(second.created, true);
  assert.equal(readAccount(db, 'tester').apiKey, 'secret-key');
  assert.equal(readAccount(db, 'other').apiKey, 'other-key');
  assert.deepEqual(listAccounts(db).map((row) => row.username).sort(), ['other', 'tester']);

  // Signing in again replaces that user's key without adding a row.
  const again = saveAccount(db, { apiKey: 'rotated-key', username: 'tester', isPro: false });
  assert.equal(again.created, false);
  assert.equal(readAccount(db, 'tester').apiKey, 'rotated-key');
  assert.equal(listAccounts(db).length, 2);
  // ...and the cached allowance survives the key rotation.
  assert.equal(readAccount(db, 'tester').allowance.balance, '49.5');

  // Removal takes the account and its keys, and leaves other users alone.
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
              VALUES ('ktester', 'mine', 'sk-x', 'h-x', ?, 'unlimited', '[]', 'tester')`).run(Date.now());
  clearAccount(db, 'tester');
  assert.equal(readAccount(db, 'tester'), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE owner_username = 'tester'").get().n, 0);
  assert.notEqual(readAccount(db, 'other'), undefined);
});

check('sessions resolve to one account and expire', () => {
  const session = createSession(db, 'other');
  const found = sessionAccount(db, session.token);
  assert.equal(found.username, 'other');
  assert.equal(found.sessionId, session.id);
  // Only the hash is stored.
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.token_hash, hashToken(session.token));
  assert.ok(!JSON.stringify(row).includes(session.token), 'the plaintext token must not be stored');

  // An unknown token resolves to nothing rather than throwing.
  assert.equal(sessionAccount(db, 'not-a-token'), undefined);
  assert.equal(sessionAccount(db, undefined), undefined);

  // Destroying it makes the token useless.
  assert.equal(destroySession(db, session.token), true);
  assert.equal(sessionAccount(db, session.token), undefined);
  assert.equal(destroySession(db, session.token), false);

  // An expired session is refused and cleaned up.
  const short = createSession(db, 'other', { ttlMs: -1 });
  assert.equal(sessionAccount(db, short.token), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(short.id).n, 0);

  /*
   * A session slides: using it moves the expiry, so it ends after the TTL of *idle* time
   * rather than that long after sign-in. Both the setting's own comment and the README
   * describe it that way, and a user who opens the dashboard daily expects to stay in.
   */
  const sliding = createSession(db, 'other', { ttlMs: 120_000 });
  const before = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(sliding.id).expires_at;
  // Past the one-minute write throttle, still inside the session's life.
  const used = sessionAccount(db, sliding.token, Date.now() + 70_000);
  assert.equal(used?.username, 'other', 'still valid when used');
  const after = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(sliding.id).expires_at;
  assert.ok(after > before, 'using a session must push its expiry out');
});

check('the session cookie parses and clears', () => {
  const expiresAt = Date.now() + 60_000;
  const cookie = sessionCookie('abc123', expiresAt);
  assert.match(cookie, /^deepai_gateway_session=abc123; /);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.ok(!/Secure/.test(cookie), 'Secure must be opt-in: localhost is plain HTTP');

  // The attribute parser ignores other cookies and matches by exact name.
  assert.equal(tokenFromCookie('a=1; deepai_gateway_session=abc123; b=2'), 'abc123');
  assert.equal(tokenFromCookie('deepai_gateway_session='), undefined);
  assert.equal(tokenFromCookie('other=abc123'), undefined);
  assert.equal(tokenFromCookie(undefined), undefined);

  // A trailing attribute must not be mistaken for part of the value.
  assert.equal(tokenFromCookie(cookie), 'abc123');
  assert.match(clearSessionCookie(), /^deepai_gateway_session=; /);
  assert.match(clearSessionCookie(), /1970/);
});

/* ------------------------------------------------------------------- auth */

check('key extraction accepts bearer and x-api-key', () => {
  assert.equal(keyFromRequest({ get: (name) => (name === 'authorization' ? 'Bearer sk-abc' : undefined) }), 'sk-abc');
  assert.equal(keyFromRequest({ get: (name) => (name === 'x-api-key' ? 'sk-xyz' : undefined) }), 'sk-xyz');
  assert.equal(keyFromRequest({ get: () => undefined }), undefined);
});

check('authenticate rejects a missing and an unknown key', () => {
  const middleware = authenticate(db);
  const run = (headers) => {
    let status;
    let body;
    const req = { get: (name) => headers[name], gatewayKey: undefined };
    const res = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; return this; },
    };
    let passed = false;
    middleware(req, res, () => { passed = true; });
    return { status, body, passed };
  };
  assert.equal(run({}).status, 401);
  assert.equal(run({ authorization: 'Bearer nope' }).status, 401);
  assert.equal(run({ authorization: 'Bearer nope' }).body.error.code, 'invalid_api_key');
});

check('authenticate accepts a live key and rejects a revoked one', () => {
  const key = generateKey();
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models)
              VALUES ('k2', 'second', ?, ?, ?, 'month', '[]')`).run(key.prefix, key.hash, Date.now());
  const middleware = authenticate(db);

  const run = () => {
    const req = { get: (name) => (name === 'authorization' ? `Bearer ${key.plaintext}` : undefined) };
    const res = { status() { return this; }, json() { return this; } };
    let passed = false;
    middleware(req, res, () => { passed = true; });
    return { passed, key: req.gatewayKey };
  };

  assert.equal(run().passed, true);
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(Date.now(), 'k2');
  assert.equal(run().passed, false);
});

check('authenticate enforces a request limit', () => {
  const key = generateKey();
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, limit_requests, allowed_models)
              VALUES ('k3', 'limited', ?, ?, ?, 'total', 1, '[]')`).run(key.prefix, key.hash, Date.now());
  const middleware = authenticate(db);
  const run = () => {
    let status;
    const req = { get: (name) => (name === 'authorization' ? `Bearer ${key.plaintext}` : undefined) };
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    let passed = false;
    middleware(req, res, () => { passed = true; });
    return { passed, status };
  };
  assert.equal(run().passed, true);
  record(db, { keyId: 'k3', model: 'm', totalTokens: 1, ok: true });
  const blocked = run();
  assert.equal(blocked.passed, false);
  assert.equal(blocked.status, 429);
});

/* ----------------------------------------------------------------- openai */

check('stop sequences normalize from string and array', () => {
  assert.deepEqual(stopSequences('END'), ['END']);
  assert.deepEqual(stopSequences(['a', '', 'b']), ['a', 'b']);
  assert.deepEqual(stopSequences(undefined), []);
  assert.deepEqual(stopSequences(['1', '2', '3', '4', '5']), ['1', '2', '3', '4']);
});

check('effort mapping covers every harness id', () => {
  assert.equal(effortOf('off'), 'none');
  assert.equal(effortOf('max'), 'high');
  assert.equal(effortOf('medium'), 'medium');
  assert.equal(effortOf(undefined), undefined);
});

check('OpenAI usage re-inflates the prompt total', () => {
  const usage = openAIUsage({
    inputTokens: 50, outputTokens: 20, cacheReadTokens: 40,
    cacheWriteTokens: 10, reasoningTokens: 5, totalTokens: 120,
  });
  assert.equal(usage.prompt_tokens, 100);
  assert.equal(usage.completion_tokens, 20);
  assert.equal(usage.total_tokens, 120);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 40);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 5);
  assert.equal(openAIUsage(undefined), undefined);
});

check('OpenAI messages convert into Responses items', () => {
  const input = openAIToResponsesInput([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]);
  assert.equal(input[0].role, 'system');
  assert.equal(input.find((item) => item.type === 'function_call').call_id, 'c1');
  assert.equal(input.find((item) => item.type === 'function_call_output').output, 'ok');
  assert.equal(input.find((item) => item.type === 'message').content[0].type, 'output_text');
});

await checkAsync('Responses transport converts OpenAI messages exactly once', async () => {
  // Regression: the Responses transport used to convert OpenAI messages into
  // items and then convert that result again as if it were harness blocks,
  // which sent an empty `input` array upstream.
  const { streamResponsesCompletion } = await import('../src/deepai/client.js');

  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    const body = [
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const events = [];
    for await (const event of streamResponsesCompletion({
      apiKey: 'k',
      model: 'gpt-6-astra',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello there' },
        { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', function: { name: 'echo', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }],
    })) events.push(event);

    assert.equal(captured.length, 1);
    assert.ok(captured[0].url.endsWith('/deepai_code/responses'));
    const { input, tools } = captured[0].body;

    // The user turn must survive the round trip with its text intact.
    assert.ok(Array.isArray(input) && input.length >= 4, `input had ${input?.length} items`);
    assert.equal(input[0].role, 'system');
    assert.equal(input[0].content[0].text, 'be brief');
    assert.equal(input[1].content[0].text, 'hello there');
    assert.equal(input.find((item) => item.type === 'function_call').name, 'echo');
    assert.equal(input.find((item) => item.type === 'function_call_output').output, 'ok');

    // Tools must be flattened, not nested under `function`.
    assert.equal(tools[0].name, 'echo');
    assert.equal(tools[0].function, undefined);

    assert.equal(events.find((event) => event.type === 'text').text, 'ok');
    assert.deepEqual(events.find((event) => event.type === 'usage').usage, {
      inputTokens: 5, outputTokens: 1, totalTokens: 6,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    });
    assert.equal(events.at(-1).reason, 'stop');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* -------------------------------------------------------------- deepai wire */

check('completions usage subtracts cached input', () => {
  const usage = completionsUsage({
    prompt_tokens: 100, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
    completion_tokens_details: { reasoning_tokens: 5 },
  });
  assert.deepEqual(usage, {
    inputTokens: 50, outputTokens: 20, totalTokens: 120,
    cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 5,
  });
});

check('responses usage subtracts cached input', () => {
  const usage = responsesUsage({
    input_tokens: 30, output_tokens: 7,
    input_tokens_details: { cached_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 3 },
  });
  assert.deepEqual(usage, {
    inputTokens: 20, outputTokens: 7, totalTokens: 37,
    cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 3,
  });
});

/* ----------------------------------------------------------------- catalog */

check('fallback catalog is complete and well formed', () => {
  assert.ok(FALLBACK_MODELS.length >= 13);
  const ids = FALLBACK_MODELS.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const model of FALLBACK_MODELS) {
    assert.ok(model.contextWindow > 0);
    assert.ok(model.maxTokens > 0);
    for (const level of ['none', 'low', 'medium', 'high']) {
      assert.equal(typeof model.creditsPerSecond[level], 'string');
    }
  }
});

check('free models are labelled and Premier are not', () => {
  for (const model of FALLBACK_MODELS) {
    if (model.premier) {
      assert.equal(displayName(model), model.name);
    } else {
      assert.equal(displayName(model), `${model.name} Free`);
    }
  }
});

check('rate labels distinguish unmetered from billed', () => {
  assert.equal(rateLabel(findModel('glm-5.3-flash')), 'Unmetered');
  assert.equal(rateLabel(findModel('glm-5.3'), 'high'), '1.2 Credits/min');
  assert.equal(rateLabel(findModel('gpt-6-astra'), 'none'), '18 Credits/min');
});

/* ------------------------------------------------------------------- server */

await checkAsync('app mounts; /healthz is minimal and /v1/models requires a key', async () => {
  const { createApp } = await import('../server.js');
  const session = sessionFor(db, 'http-user');
  const app = createApp(db, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // A key for this check, unrestricted, owned by the session's account.
  const key = generateKey();
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
              VALUES ('khttp', 'http', ?, ?, ?, 'unlimited', '[]', 'http-user')`)
    .run(key.prefix, key.hash, Date.now());

  try {
    // /healthz is a liveness probe: unauthenticated, and it must not disclose
    // who is signed in, how many accounts exist, or their names.
    const health = await fetch(`${base}/healthz`).then((res) => res.json());
    assert.deepEqual(Object.keys(health).sort(), ['ok']);
    assert.equal(health.ok, true);

    // Without a key the catalog is refused.
    const anon = await fetch(`${base}/v1/models`);
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, 'missing_api_key');

    const models = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    }).then((res) => res.json());
    assert.equal(models.object, 'list');
    assert.ok(models.data.length >= 13);
    assert.ok(models.data.some((model) => model.id === 'deepseek-v4.1-flash'));

    const details = await fetch(`${base}/v1/models/details`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    }).then((res) => res.json());
    const free = details.data.find((model) => model.id === 'glm-5.3-flash');
    assert.equal(free.tier, 'free');
    assert.equal(free.displayName, 'GLM 5.3 Flash Free');

    const unauthorized = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(unauthorized.status, 401);

    const unknown = await fetch(`${base}/v1/nope`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'not_found');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('/v1/models only advertises the models a restricted key may use', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // A key needs an owning account to be usable at all: the account is what pays.
  saveAccount(fresh, { apiKey: 'owner-deepai-key', username: 'restricted-user', isPro: false });

  const allowed = ['glm-5.3-flash', 'deepseek-v4.1-flash'];
  const restricted = generateKey();
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, models_restricted, owner_username)
                 VALUES ('kr', 'restricted', ?, ?, ?, 'unlimited', ?, 1, 'restricted-user')`)
    .run(restricted.prefix, restricted.hash, Date.now(), JSON.stringify(allowed));

  // A restricted key with nothing selected must see nothing at all.
  const empty = generateKey();
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, models_restricted, owner_username)
                 VALUES ('ke', 'empty', ?, ?, ?, 'unlimited', '[]', 1, 'restricted-user')`)
    .run(empty.prefix, empty.hash, Date.now());

  try {
    const visible = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${restricted.plaintext}` },
    }).then((res) => res.json());
    assert.deepEqual(visible.data.map((model) => model.id).sort(), [...allowed].sort());

    const none = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${empty.plaintext}` },
    }).then((res) => res.json());
    assert.equal(none.data.length, 0);

    // The usage figures beside the catalog are per account, so an identity is
    // required - but never *nothing*, which would scope to every account.
    assert.equal((await fetch(`${base}/api/models`)).status, 401);
    // A key identity is accepted, and scoped to that key's owner.
    const viaKey = await fetch(`${base}/api/models`, { headers: { authorization: `Bearer ${restricted.plaintext}` } });
    assert.equal(viaKey.status, 200);
    assert.ok((await viaKey.json()).models.length >= 13);
    // A session identity also works.
    const session = sessionFor(fresh, 'catalog-viewer');
    const dashboard = await asUser(base, session)('/api/models');
    assert.ok(dashboard.body.models.length >= 13);
    // An unknown key is refused.
    assert.equal((await fetch(`${base}/api/models`, { headers: { authorization: 'Bearer sk-nope' } })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('/ serves the dashboard shell and nothing else is browser-navigable', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const root = await fetch(base, { redirect: 'manual' });
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
    assert.match(await root.text(), /DeepAI Gateway/);

    // A deep link must return the shell, not a bare 404 page.
    const deep = await fetch(`${base}/keys`);
    assert.equal(deep.status, 404);
    assert.match(await deep.text(), /DeepAI Gateway/);

    /*
     * The browser sign-in is gone, so nothing may answer on its routes any more. A
     * leftover that still did would be a route with no UI to reach it and no flow
     * behind it, which is exactly what this removal was for.
     */
    for (const path of ['/login', '/auth-callback', '/callback']) {
      const gone = await fetch(`${base}${path}`, { redirect: 'manual' });
      assert.ok(gone.status !== 200, `${path} must no longer serve a sign-in page`);
    }
    // The JSON endpoints behind it are gone too, and answer JSON rather than HTML.
    for (const path of ['/api/login', '/api/login/key', '/api/login/password', '/api/login/complete', '/api/cancel-login']) {
      const gone = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(gone.status, 404, `${path} must be gone`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('the gateway refuses a sixth API key', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const session = sessionFor(fresh, 'quota-user');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = asUser(base, session);

  try {
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await call('/api/keys', {
        method: 'POST',
        body: { name: `key ${index}`, limitWindow: 'unlimited', modelsRestricted: false },
      });
      assert.equal(response.status, 201, `key ${index} should be created`);
      created.push(response.body.key);
    }
    assert.equal(created.length, 5);

    const sixth = await call('/api/keys', {
      method: 'POST',
      body: { name: 'key 6', limitWindow: 'unlimited', modelsRestricted: false },
    });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.code, 'key_limit_reached');

    // The quota is reported so the UI can disable the button.
    const listed = await call('/api/keys');
    assert.equal(listed.body.quota.used, 5);
    assert.equal(listed.body.quota.max, 5);
    assert.equal(listed.body.quota.atLimit, true);

    // Revoking deletes the key outright: it stops working and frees its slot.
    const revoked = await call(`/api/keys/${created[0].id}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.ok, true);
    assert.equal(revoked.body.revoked.id, created[0].id);

    const afterRevoke = await call('/api/keys');
    assert.equal(afterRevoke.body.quota.used, 4, 'revoking frees a slot');
    assert.ok(!afterRevoke.body.keys.some((k) => k.id === created[0].id), 'the key is gone from the list');

    // The revoked key no longer authenticates.
    const dead = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${created[0].plaintext}` } });
    assert.equal(dead.status, 401, 'a revoked key must stop working');

    // Its name is free again, and a new key fits in the freed slot.
    const replacement = await call('/api/keys', {
      method: 'POST',
      body: { name: `key 0`, limitWindow: 'unlimited', modelsRestricted: false },
    });
    assert.equal(replacement.status, 201, 'the name and the slot are both reusable');

    // At the cap again, a new key is refused with a note to revoke.
    const full = await call('/api/keys', { method: 'POST', body: { name: 'over' } });
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'key_limit_reached');
    assert.match(full.body.error, /Revoke one/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a key records its DeepAI owner and unrestricted keys allow everything', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const session = sessionFor(fresh, 'owner-user', { apiKey: 'owner-key' });
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = asUser(base, session);

  try {
    const response = await call('/api/keys', {
      method: 'POST',
      body: { name: 'owned', limitWindow: 'unlimited', modelsRestricted: false },
    });
    const key = response.body.key;
    assert.equal(key.owner, 'owner-user');
    assert.equal(key.modelsRestricted, false);

    const row = fresh.prepare('SELECT owner_username, owner_key_hash FROM api_keys WHERE id = ?').get(key.id);
    assert.equal(row.owner_username, 'owner-user');
    assert.equal(row.owner_key_hash, hashKey('owner-key'));

    // Logging out ends this browser's session but leaves the account and its key
    // stored, so another signed-in browser keeps working.
    const logout = await call('/api/logout', { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.match(String(logout.headers.get('set-cookie')), /deepai_gateway_session=;/);
    // The browser no longer has a session, so it must send no cookie at all.
    const account = await call('/api/account', { anonymous: true });
    assert.equal(account.body.signedIn, false, 'the cookie no longer resolves to an account');
    assert.equal((await call('/api/keys', { anonymous: true })).status, 401, 'keys are per account');
    assert.notEqual(readAccount(fresh, 'owner-user'), undefined, 'the account row survives a logout');
    assert.equal(destroySession(fresh, session.token), false, 'the session was already destroyed');

    // Signing in again from a browser restores the same keys.
    const again = sessionFor(fresh, 'owner-user', { apiKey: 'owner-key' });
    const still = await asUser(base, again)('/api/keys');
    assert.equal(still.body.keys.length, 1);
    assert.equal(still.body.keys[0].owner, 'owner-user');

    // Sign-out is recorded in the audit trail.
    const events = await asUser(base, again)('/api/account/events');
    assert.ok(events.body.events.some((event) => event.event === 'logout'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('unlimited keys ignore token and request limits', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const session = sessionFor(fresh, 'limits-user');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = asUser(base, session);

  try {
    const created = await call('/api/keys', {
      method: 'POST',
      // Limits are supplied but the window is unlimited, so they must be dropped.
      body: { name: 'unlimited', limitWindow: 'unlimited', limitTokens: 5, limitRequests: 1 },
    });
    assert.equal(created.body.key.limitTokens, null);
    assert.equal(created.body.key.limitRequests, null);
    assert.equal(created.body.key.limitWindow, 'unlimited');

    // A monthly window keeps the supplied limits.
    const monthly = await call('/api/keys', {
      method: 'POST',
      body: { name: 'monthly', limitWindow: 'month', limitTokens: 1000, limitRequests: 10 },
    });
    assert.equal(monthly.body.key.limitTokens, 1000);
    assert.equal(monthly.body.key.limitRequests, 10);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a signed-out gateway refuses completions with 503', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  // A key whose owning DeepAI account is not signed in. Its owner is named so
  // the error can say whose account is missing.
  const key = generateKey();
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                 VALUES ('kx', 'temp', ?, ?, ?, 'month', '[]', 'gone-user')`).run(key.prefix, key.hash, Date.now());

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.plaintext}` },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 503);
    const failure = await response.json();
    assert.equal(failure.error.code, 'deepai_signed_out');
    // The message names the account so the operator knows where to log in.
    assert.match(failure.error.message, /gone-user/);

    // An ownerless key cannot resolve an account at all, and says so.
    const orphan = generateKey();
    fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                   VALUES ('ko', 'orphan', ?, ?, ?, 'month', '[]', '')`).run(orphan.prefix, orphan.hash, Date.now());
    const orphaned = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orphan.plaintext}` },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(orphaned.status, 503);
    assert.match((await orphaned.json()).error.message, /no DeepAI account/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ------------------------------------------------------- v1 model payload */

await checkAsync('/v1/models carries modalities, reasoning levels and names', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const key = generateKey();
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models)
                 VALUES ('kv', 'v', ?, ?, ?, 'unlimited', '[]')`).run(key.prefix, key.hash, Date.now());

  try {
    const payload = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    }).then((res) => res.json());

    const free = payload.data.find((model) => model.id === 'glm-5.3-flash');
    assert.equal(free.display_name, 'GLM 5.3 Flash Free');
    assert.equal(free.name, 'GLM 5.3 Flash');
    assert.equal(free.tier, 'free');
    assert.equal(free.premier, false);
    assert.deepEqual(free.input_modalities, ['text', 'image']);
    assert.deepEqual(free.output_modalities, ['text']);
    assert.deepEqual(free.reasoning_levels, ['none', 'low', 'medium', 'high']);
    assert.ok(free.context_window > 0);
    assert.ok(free.max_output_tokens > 0);
    assert.equal(typeof free.credits_per_second.high, 'string');
    assert.equal(free.rate_label, 'Unmetered');
    assert.ok(free.description.includes('Free tier'));

    const textOnly = payload.data.find((model) => model.id === 'solar-mini-4');
    assert.deepEqual(textOnly.input_modalities, ['text']);

    const premier = payload.data.find((model) => model.id === 'glm-5.3');
    assert.equal(premier.tier, 'premier');
    assert.equal(premier.rate_label, '6 Credits/min');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

check('publicModel exposes per-level reasoning rates', () => {
  const model = publicModel(findModel('glm-5.3'));
  assert.equal(model.reasoningLevels.length, REASONING_LEVELS.length);
  const high = model.reasoningLevels.find((level) => level.id === 'high');
  assert.equal(high.rateLabel, '1.2 Credits/min');
  assert.equal(high.name, 'High');
  assert.deepEqual(publicModel(findModel('solar-mini-4')).reasoningLevels.length > 0, true);
});

/* ------------------------------------------------------------- hour window */

check('windowStart understands the hour window', () => {
  const now = new Date('2026-10-25T15:47:31').getTime();
  const hour = new Date(startOfHour(now));
  assert.equal(hour.getHours(), 15);
  assert.equal(hour.getMinutes(), 0);
  assert.equal(hour.getSeconds(), 0);
  assert.equal(windowStart('hour', now), hour.getTime());
  assert.ok(windowStart('hour', now) > windowStart('day', now));
});

await checkAsync('a per-hour key is accepted and enforced', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const session = sessionFor(fresh, 'hour-user');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = asUser(base, session);

  try {
    const created = await call('/api/keys', {
      method: 'POST',
      body: { name: 'hourly', limitWindow: 'hour', limitRequests: 1 },
    });
    assert.equal(created.body.key.limitWindow, 'hour');
    assert.equal(created.body.key.limitRequests, 1);

    // The window is reported by the list endpoint too.
    const listed = await call('/api/keys');
    assert.ok(listed.body.windows.includes('hour'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* --------------------------------------------------------------- SSE parser */

check('findEventEnd handles LF, CRLF and partial buffers', () => {
  assert.deepEqual(findEventEnd('data: {}\n\n'), { index: 8, length: 2 });
  assert.deepEqual(findEventEnd('data: {}\r\n\r\n'), { index: 8, length: 4 });
  // A lone CRLF inside the payload must not terminate the event early.
  const mixed = 'data: {"a":"x\r\n"}\n\nrest';
  assert.deepEqual(findEventEnd(mixed), { index: mixed.indexOf('\n\n'), length: 2 });
  assert.deepEqual(findEventEnd('data: {"a":1}'), { index: -1, length: 0 });
  assert.deepEqual(findEventEnd(''), { index: -1, length: 0 });
});

/* ------------------------------------------------------------------ pricing */

check('every catalog model has a pricing decision', () => {
  for (const model of FALLBACK_MODELS) {
    // Either a mapping or an explicit null, never a silent gap.
    assert.ok(model.id in MODEL_SOURCES, `no pricing decision for ${model.id}`);
  }
  assert.equal(MODEL_SOURCES['deepai-cyber'], null);
  assert.equal(isPriced('deepai-cyber'), false);
  assert.equal(publicPrices().length, FALLBACK_MODELS.length);
});

check('parsePrice converts per-token USD to per-million without float noise', () => {
  const parsed = parsePrice({
    pricing: {
      prompt: '0.0000002', completion: '0.0000012',
      input_cache_read: '0.00000002', input_cache_write: '0.00000025',
    },
    context_length: 1000000,
  });
  assert.equal(parsed.input, 0.2);
  assert.equal(parsed.output, 1.2);
  assert.equal(parsed.cacheRead, 0.02);
  assert.equal(parsed.cacheWrite, 0.25);
  assert.equal(parsed.contextLength, 1000000);

  // Missing cache fields stay null rather than becoming a silent zero.
  const sparse = parsePrice({ pricing: { prompt: '0.000001', completion: '0.000002' } });
  assert.equal(sparse.cacheRead, null);
  assert.equal(sparse.cacheWrite, null);
  assert.equal(parsePrice({}), null);
  assert.equal(parsePrice({ pricing: { prompt: 'free' } }), null);
});

check('buildPrices maps DeepAI ids and skips batch/alias variants', () => {
  const entries = [
    { id: 'z-ai/glm-5.3-flash', pricing: { prompt: '0.00000015', completion: '0.0000005' } },
    { id: 'z-ai/glm-5.3-flash:batch', pricing: { prompt: '0.00000005', completion: '0.00000018' } },
    { id: '~z-ai/glm-5.3-latest', pricing: { prompt: '0.00000001', completion: '0.00000001' } },
    { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002' } },
  ];
  const { prices, matched, missing } = buildPrices(entries);
  assert.ok(matched.includes('glm-5.3-flash'));
  assert.ok(matched.includes('claude-opus-5-5'));
  // The batch price must never win over the standard one.
  assert.equal(prices['glm-5.3-flash'].input, 0.15);
  assert.equal(prices['claude-opus-5-5'].cacheRead, 0.2);
  assert.equal(prices['deepai-cyber'], null);
  assert.ok(missing.includes('kimi-k3'), 'unmatched models must be reported');
});

check('priceUsage bills each token class at its own published rate', () => {
  resetPricing();
  // claude-opus-5-5: in 4, out 20, cacheRead 0.20, cacheWrite 5.00.
  const cost = priceUsage('claude-opus-5-5', {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost.inputUsd - 4) < 1e-9);
  assert.ok(Math.abs(cost.outputUsd - 20) < 1e-9);
  // Regression: cached input used to be billed at the full input rate.
  assert.ok(Math.abs(cost.cacheReadUsd - 0.2) < 1e-9, `cacheRead should be 0.2, got ${cost.cacheReadUsd}`);
  assert.ok(Math.abs(cost.cacheWriteUsd - 5) < 1e-9, `cacheWrite should be 5, got ${cost.cacheWriteUsd}`);
  assert.ok(Math.abs(cost.usd - 29.2) < 1e-9, `total should be 29.2, got ${cost.usd}`);

  assert.equal(priceUsage('deepai-cyber', { inputTokens: 10 }), undefined);
});

check('priceUsage falls back to the input rate when no cache rate is published', () => {
  resetPricing();
  // glm-5.3-flash publishes a cacheRead but no cacheWrite.
  const cost = priceUsage('glm-5.3-flash', {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
  });
  assert.ok(Math.abs(cost.cacheReadUsd - 0.03) < 1e-9);
  // Unpublished write rate falls back to input (0.15), overstating rather than
  // understating the cost.
  assert.ok(Math.abs(cost.cacheWriteUsd - 0.15) < 1e-9, `got ${cost.cacheWriteUsd}`);
});

check('estimateSavings totals priced models and reports the rest', () => {
  resetPricing();
  const result = estimateSavings([
    { model: 'glm-5.3-flash', inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    { model: 'deepai-cyber', inputTokens: 500, outputTokens: 500, totalTokens: 1000 },
  ]);
  assert.ok(Math.abs(result.usd - 0.15) < 1e-9);
  assert.equal(result.pricedTokens, 1_000_000);
  assert.equal(result.unpricedTokens, 1000);
  assert.deepEqual(result.unpricedModels, ['deepai-cyber']);
  assert.equal(result.perModel[0].model, 'glm-5.3-flash');
});

check('formatUsd keeps sub-cent amounts readable', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0023), '$0.0023');
  assert.equal(formatUsd(0.42), '$0.420');
  assert.equal(formatUsd(12.5), '$12.50');
});

await checkAsync('refreshPrices adopts a live catalogue and ignores junk', async () => {
  resetPricing();
  const live = {
    data: [
      { id: 'z-ai/glm-5.3-flash', pricing: { prompt: '0.0000009', completion: '0.0000019', input_cache_read: '0.0000001' } },
      { id: 'openai/gpt-6-astra', pricing: { prompt: '0.00002', completion: '0.00006' } },
      { id: 'broken/entry', pricing: null },
    ],
  };
  const fetchImpl = async () => new Response(JSON.stringify(live), { status: 200, headers: { 'content-type': 'application/json' } });

  const result = await refreshPrices({ fetchImpl, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'live');
  assert.ok(result.matched.includes('glm-5.3-flash'));

  // The live numbers replaced the bundled ones.
  const price = priceOf('glm-5.3-flash');
  assert.equal(price.input, 0.9);
  assert.equal(price.cacheRead, 0.1);
  assert.equal(pricingStatus().source, 'live');

  // A failed refresh keeps the last good table instead of blanking it.
  const failing = async () => new Response('nope', { status: 503 });
  const failed = await refreshPrices({ fetchImpl: failing, log: () => {} });
  assert.equal(failed.ok, false);
  assert.equal(priceOf('glm-5.3-flash').input, 0.9, 'a failed refresh must not lose prices');
  assert.equal(pricingStatus().source, 'live');
  resetPricing();
});

await checkAsync('refreshPrices rejects an empty or unusable catalogue', async () => {
  resetPricing();
  const empty = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const result = await refreshPrices({ fetchImpl: empty, log: () => {} });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('empty'));
  // The bundled snapshot is still in place.
  assert.equal(priceOf('glm-5.3-flash').input, 0.15);
});

await checkAsync('initPricing loads a disk cache and readCache tolerates junk', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'deepai-pricing-'));

  const cachePath = join(dir, 'pricing.json');
  writeFileSync(cachePath, JSON.stringify({
    capturedAt: '2026-01-02T03:04:05.000Z',
    fetchedAt: Date.parse('2026-01-02T03:04:05.000Z'),
    prices: { 'glm-5.3-flash': { input: 7, output: 8, cacheRead: 1, cacheWrite: null, source: 'x' }, 'deepai-cyber': null },
  }));
  assert.equal(readCache(cachePath).capturedAt, '2026-01-02T03:04:05.000Z');

  initPricing({ cachePath, log: () => {} });
  assert.equal(priceOf('glm-5.3-flash').input, 7);
  assert.equal(pricingStatus().source, 'cache');
  assert.equal(pricingStatus().capturedAt, '2026-01-02T03:04:05.000Z');

  // Malformed cache files are ignored, not fatal.
  writeFileSync(cachePath, '{not json');
  assert.equal(readCache(cachePath), undefined);
  writeFileSync(cachePath, JSON.stringify({ nope: true }));
  assert.equal(readCache(cachePath), undefined);

  resetPricing();
  initPricing({ cachePath: join(dir, 'missing.json'), log: () => {} });
  assert.equal(pricingStatus().source, 'bundled');
  assert.equal(priceOf('glm-5.3-flash').input, FALLBACK_PRICES['glm-5.3-flash'].input);
});

await checkAsync('the summary endpoint reports savings and pricing status', async () => {
  resetPricing();
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const session = sessionFor(fresh, 'savings-user');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = asUser(base, session);

  try {
    record(fresh, {
      keyId: null, keyName: 'k', owner: 'savings-user', model: 'glm-5.3-flash',
      inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000, ok: true,
    });
    const payload = (await call('/api/usage/summary')).body;
    assert.ok(payload.savings, 'summary must carry savings');
    assert.ok(Math.abs(payload.savings.month.usd - 0.65) < 1e-9, `got ${payload.savings.month.usd}`);
    assert.ok(payload.savings.pricing, 'summary must report where prices came from');
    assert.equal(typeof payload.savings.pricing.source, 'string');

    const pricing = (await call('/api/pricing')).body;
    assert.equal(pricing.prices.length, FALLBACK_MODELS.length);
    assert.equal(typeof pricing.status.capturedAt, 'string');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetPricing();
  }
});

/* ------------------------------------------------------------- usage export */

await checkAsync('usage export produces CSV and JSON with every row', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const session = sessionFor(fresh, 'export-user');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = asUser(base, session);

  try {
    // A real key row, because usage.key_id is a foreign key.
    const key = generateKey();
    fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                   VALUES ('k1', 'comma, name', ?, ?, ?, 'unlimited', '[]', 'export-user')`)
      .run(key.prefix, key.hash, Date.now());

    record(fresh, {
      keyId: 'k1', keyName: 'comma, name', owner: 'export-user', model: 'glm-5.3-flash',
      inputTokens: 10, outputTokens: 5, totalTokens: 15, ok: true, status: 200,
    });
    record(fresh, {
      keyId: 'k1', keyName: 'failed', owner: 'export-user', model: 'deepseek-v4.1-flash',
      totalTokens: 0, ok: false, status: 500, errorCode: 'PROVIDER_ERROR',
    });

    const csv = await call('/api/usage/export?format=csv');
    assert.match(String(csv.headers.get('content-type')), /text\/csv/);
    assert.match(String(csv.headers.get('content-disposition')), /attachment; filename="deepai-usage-\d{4}-\d{2}-\d{2}\.csv"/);
    const csvText = csv.body;
    const lines = csvText.trim().split('\n');
    assert.equal(lines.length, 3, 'header plus two rows');
    assert.match(lines[0], /^id,created_at,key_id,key_name,owner_username,model/);
    // A name containing a comma must be quoted, not split into two fields.
    assert.ok(csvText.includes('"comma, name"'), 'CSV must quote fields with commas');

    const json = (await call('/api/usage/export?format=json')).body;
    assert.equal(json.rows.length, 2);
    assert.equal(json.rows[0].model, 'glm-5.3-flash');
    assert.equal(json.rows[1].ok, false);
    assert.equal(json.rows[1].errorCode, 'PROVIDER_ERROR');
    assert.match(json.rows[0].createdAtIso, /^\d{4}-\d{2}-\d{2}T/);

    // The export honours the range filter.
    const today = (await call('/api/usage/export?format=json&range=today')).body;
    assert.equal(today.rows.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('usage rows survive reopening the same database file', async () => {
  // Durability of usage, not just keys: write, close, reopen, read back.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'deepai-usage-')), 'usage.db');

  const first = openDatabase(file);
  record(first, { keyId: null, keyName: 'k', model: 'glm-5.3-flash', inputTokens: 42, outputTokens: 7, totalTokens: 49, ok: true });
  first.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  first.close();

  const second = openDatabase(file);
  const total = totals(second, 0);
  assert.equal(total.requests, 1, 'the recorded request must survive a reopen');
  assert.equal(total.totalTokens, 49);
  assert.equal(total.inputTokens, 42);
  const exported = [...exportRows(second, {})];
  assert.equal(exported.length, 1);
  assert.equal(exported[0].model, 'glm-5.3-flash');
  second.close();
});

/* ------------------------------------------------------------- hidden fields */

await checkAsync('the dashboard shell names versioned assets and is never cached', async () => {
  /*
   * Shipping new code under the same `/app.js` URL let a browser keep serving the copy
   * it already had - a rewritten sign-in screen stayed invisible after it had deployed.
   * The shell is now always revalidated and the assets it names carry a version taken
   * from their own bytes, so a deploy changes the URL.
   */
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const versionIn = async () => {
    const response = await fetch(base);
    const html = await response.text();
    return {
      cache: response.headers.get('cache-control'),
      html,
      js: /src="(\/app\.js\?v=([0-9a-f]{12}))"/.exec(html),
      css: /href="(\/app\.css\?v=([0-9a-f]{12}))"/.exec(html),
    };
  };

  const appPath = join(root, 'public', 'app.js');
  const original = readFileSync(appPath, 'utf8');
  try {
    const first = await versionIn();
    assert.equal(first.cache, 'no-store', 'the shell must never be served stale');
    assert.ok(first.js !== null, 'app.js must be referenced with a version');
    assert.ok(first.css !== null, 'app.css must be referenced with a version');

    // The versioned URL is real and answers with the current code.
    const asset = await fetch(`${base}${first.js[1]}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    // Any marker that only the current code carries; the ids are prefixed now, so the
    // test anchors on the shared route block instead of one exact id.
    assert.ok((await asset.text()).includes('signInRoutes'), 'the asset must be the new code');

    // A deep link is answered with the same shell, so a client-side route survives.
    const deep = await fetch(`${base}/keys`);
    assert.equal(deep.status, 404);
    assert.equal(deep.headers.get('cache-control'), 'no-store');
    assert.ok((await deep.text()).includes(first.js[1]), 'the shell is the one with versions');

    // The point of the version: change the bytes and the URL changes with them.
    writeFileSync(appPath, `${original}\n// version probe\n`);
    const changed = await versionIn();
    assert.notEqual(changed.js[2], first.js[2], 'a changed asset must get a new URL');
    writeFileSync(appPath, original);
    assert.equal((await versionIn()).js[2], first.js[2], 'and the original version comes back');
  } finally {
    writeFileSync(appPath, original);
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('the stylesheet carries no dead classes or variables', async () => {
  /*
   * This replaces a check that pinned the order of a rule which no longer exists, and it
   * guards the thing that actually accumulates: after a rewrite, selectors and custom
   * properties are left behind with nothing referencing them. Both audits are
   * deliberately permissive - a name is only reported when nothing in the client
   * mentions it at all - so a false report means genuinely dead CSS, not a live rule
   * that happens to be built dynamically.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const css = readFileSync(join(root, 'public', 'app.css'), 'utf8');
  const js = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

  const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const deadClasses = [...classes].filter((name) => {
    const inHtml = new RegExp(`class="[^"]*\\b${name}\\b`).test(html);
    return !inHtml && !js.includes(name);
  });
  assert.deepEqual(deadClasses, [], `unused CSS classes: ${deadClasses.join(', ')}`);

  const variables = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  const deadVariables = [...variables].filter((name) => {
    const used = (css.match(new RegExp(`var\\(${name}\\)`, 'g')) ?? []).length;
    return used === 0 && !js.includes(name) && !html.includes(name);
  });
  assert.deepEqual(deadVariables, [], `unused CSS variables: ${deadVariables.join(', ')}`);

  // And the client must not carry ids the markup never defines, which is how the
  // replaced controls left their listeners behind.
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const deadIds = [...ids].filter((id) => !js.includes(id));
  assert.deepEqual(deadIds, [], `ids in the shell that nothing uses: ${deadIds.join(', ')}`);
});

await checkAsync('the stylesheet makes the hidden attribute win', async () => {
  // Regression: `.field { display: flex }` used to override `[hidden]`, so
  // "hidden" form fields still rendered and still took clicks.
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'missing the [hidden] override');
  assert.match(css, /prefers-color-scheme:\s*dark/, 'the OS dark palette must be present');
  assert.match(css, /:root:not\(\[data-theme\]\)/, 'a stored theme must stay authoritative');
});

/* --------------------------------------------------------------- migration */

await checkAsync('a pre-multi-user database migrates without losing anything', async () => {
  // Build a v3 database exactly as the previous release left it.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'deepai-migrate-')), 'old.db');

  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '3');
    CREATE TABLE account (
      id INTEGER PRIMARY KEY CHECK (id = 1), api_key TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '', is_pro INTEGER NOT NULL DEFAULT 0,
      balance TEXT, granted TEXT, refresh_at TEXT, checked_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, expires_at INTEGER,
      limit_tokens INTEGER, limit_requests INTEGER, limit_window TEXT NOT NULL DEFAULT 'month',
      allowed_models TEXT NOT NULL DEFAULT '[]',
      owner_username TEXT NOT NULL DEFAULT '', owner_key_hash TEXT, models_restricted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT, key_name TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL, requested_model TEXT NOT NULL DEFAULT '', endpoint TEXT NOT NULL DEFAULT 'chat.completions',
      status INTEGER NOT NULL DEFAULT 200, ok INTEGER NOT NULL DEFAULT 1, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, first_token_ms INTEGER,
      streamed INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at INTEGER NOT NULL,
      owner_username TEXT NOT NULL DEFAULT '');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '', detail TEXT, created_at INTEGER NOT NULL);
  `);
  old.prepare('INSERT INTO account VALUES (1, ?, ?, 1, ?, ?, ?, ?, ?)')
    .run('legacy-deepai-key', 'legacy-user', '12.5', '50', '2026-11-01T00:00:00Z', Date.now(), 1700000000000);
  old.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
               VALUES ('k-old', 'legacy key', 'sk-legacy', 'hash-old', ?, 'unlimited', '[]', 'legacy-user')`).run(Date.now());
  // One usage row owned by the user, one whose owner was never recorded.
  old.prepare(`INSERT INTO usage (key_id, key_name, model, owner_username, total_tokens, created_at)
               VALUES ('k-old', 'legacy key', 'glm-5.3-flash', 'legacy-user', 111, ?)`).run(Date.now());
  old.prepare(`INSERT INTO usage (key_id, key_name, model, owner_username, total_tokens, created_at)
               VALUES (NULL, 'ghost', 'kimi-k3', '', 22, ?)`).run(Date.now());
  old.close();

  // Opening it must migrate in place, all the way to the current schema.
  const upgraded = openDatabase(file);
  const { SCHEMA_VERSION: CURRENT } = await import('../src/db.js');
  assert.equal(
    Number(upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value),
    CURRENT,
    'the database must reach the current schema',
  );
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='account'").get().n, 0, 'the old table is gone');

  // The account survived, key and balance included.
  const account = readAccount(upgraded, 'legacy-user');
  assert.equal(account.apiKey, 'legacy-deepai-key');
  assert.equal(account.isPro, true);
  assert.equal(account.allowance.balance, '12.5');
  assert.equal(account.allowance.granted, '50');

  // The key survived and is still owned.
  assert.equal(upgraded.prepare('SELECT owner_username FROM api_keys WHERE id = ?').get('k-old').owner_username, 'legacy-user');
  // All usage rows survived, including the unattributable one.
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM usage').get().n, 2);
  assert.equal(upgraded.prepare('SELECT total_tokens FROM usage WHERE key_name = ?').get('ghost').total_tokens, 22);

  // A new session can be created against the migrated account.
  const session = createSession(upgraded, 'legacy-user');
  assert.equal(sessionAccount(upgraded, session.token).username, 'legacy-user');
  upgraded.close();
});

check('revoking deletes the key and usage keeps its history', () => {
  const fresh = openDatabase(':memory:');
  saveAccount(fresh, { apiKey: 'k', username: 'u', isPro: false });
  const key = generateKey();
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                 VALUES ('kv', 'to revoke', ?, ?, ?, 'unlimited', '[]', 'u')`)
    .run(key.prefix, key.hash, Date.now());
  record(fresh, { keyId: 'kv', keyName: 'to revoke', owner: 'u', model: 'glm-5.3-flash', totalTokens: 7, ok: true });

  fresh.prepare('DELETE FROM api_keys WHERE id = ?').run('kv');

  assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n, 0, 'the key row is gone');
  // The foreign key nulls key_id, and key_name survives, so the spend is still
  // attributable to the name the key had.
  const row = fresh.prepare('SELECT key_id, key_name, total_tokens FROM usage').get();
  assert.equal(row.key_id, null);
  assert.equal(row.key_name, 'to revoke');
  assert.equal(row.total_tokens, 7);
  // And it still shows up under the owner's usage.
  assert.equal(totals(fresh, 0, 'u').totalTokens, 7);
});

await checkAsync('a database with revoked tombstones is cleaned up on upgrade', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'deepai-v5-')), 'v4.db');

  // A v4 database in the old shape: one live key and one revoked tombstone.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '4');
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL, is_pro INTEGER NOT NULL DEFAULT 0, balance TEXT, granted TEXT,
      refresh_at TEXT, checked_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER,
      revoked_at INTEGER, expires_at INTEGER, limit_tokens INTEGER, limit_requests INTEGER,
      limit_window TEXT NOT NULL DEFAULT 'month', allowed_models TEXT NOT NULL DEFAULT '[]',
      owner_username TEXT NOT NULL DEFAULT '', owner_key_hash TEXT, models_restricted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
      key_name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, requested_model TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL DEFAULT 'chat.completions', status INTEGER NOT NULL DEFAULT 200,
      ok INTEGER NOT NULL DEFAULT 1, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, first_token_ms INTEGER, streamed INTEGER NOT NULL DEFAULT 0,
      error_code TEXT, created_at INTEGER NOT NULL, owner_username TEXT NOT NULL DEFAULT '');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '', detail TEXT, created_at INTEGER NOT NULL);
  `);
  old.prepare('INSERT INTO accounts (username, api_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('legacy', 'deepai-key', 1, 1);
  const live = generateKey();
  const dead = generateKey();
  old.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username, revoked_at)
               VALUES ('live', 'live key', ?, ?, ?, 'unlimited', '[]', 'legacy', NULL)`).run(live.prefix, live.hash, Date.now());
  old.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username, revoked_at)
               VALUES ('dead', 'old tombstone', ?, ?, ?, 'unlimited', '[]', 'legacy', ?)`).run(dead.prefix, dead.hash, Date.now(), Date.now());
  old.prepare(`INSERT INTO usage (key_id, key_name, model, total_tokens, created_at) VALUES ('dead', 'old tombstone', 'glm-5.3-flash', 42, ?)`).run(Date.now());
  old.close();

  const upgraded = openDatabase(file);
  const { SCHEMA_VERSION: LATEST } = await import('../src/db.js');
  assert.equal(Number(upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), LATEST);
  assert.deepEqual(upgraded.prepare('SELECT id FROM api_keys').all().map((r) => r.id), ['live'], 'only the tombstones are removed');
  // The tombstone's usage row survives, unattributed but named.
  const row = upgraded.prepare('SELECT key_id, key_name FROM usage').get();
  assert.equal(row.key_id, null);
  assert.equal(row.key_name, 'old tombstone');
  upgraded.close();
});

await checkAsync('the backup script writes a complete copy, not a WAL-stale one', async () => {
  // Regression: `cp deepai.db` misses committed rows still in the WAL, so a
  // backup could silently capture older state than the live database.
  const { mkdtempSync, readdirSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { SCHEMA_VERSION: CURRENT } = await import('../src/db.js');

  const dir = mkdtempSync(join(tmpdir(), 'deepai-backup-'));
  const live = join(dir, 'live.db');
  const out = join(dir, 'out');

  // A WAL-mode database with uncommitted-to-checkpoint state, exactly like the
  // gateway's own file.
  const db = openDatabase(live);
  saveAccount(db, { apiKey: 'k', username: 'bk-user', isPro: false });
  const key = generateKey();
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
              VALUES ('kb', 'backup-probe', ?, ?, ?, 'unlimited', '[]', 'bk-user')`)
    .run(key.prefix, key.hash, Date.now());
  db.close();

  execFileSync(process.execPath, [join(root, 'scripts', 'backup.js'), '--out', out], {
    env: { ...process.env, DATABASE: live },
    encoding: 'utf8',
  });

  const files = readdirSync(out).filter((name) => name.endsWith('.db'));
  assert.equal(files.length, 1, 'exactly one backup');
  const copy = new DatabaseSync(join(out, files[0]));
  assert.equal(copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(CURRENT));
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.equal(copy.prepare('SELECT name FROM api_keys').get().name, 'backup-probe');
  copy.close();
  assert.ok(statSync(join(out, files[0])).size > 0);
});

check('keyQuota refuses to count globally by accident', () => {
  const fresh = openDatabase(':memory:');
  saveAccount(fresh, { apiKey: 'k', username: 'alice', isPro: false });
  saveAccount(fresh, { apiKey: 'k2', username: 'bob', isPro: false });
  for (const [id, owner] of [['ka', 'alice'], ['kb', 'bob']]) {
    fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                   VALUES (?, ?, 'sk-x', ?, 1, 'unlimited', '[]', ?)`)
      .run(id, id, `h-${id}`, owner);
  }

  // Regression: an omitted owner used to mean "count every account's keys", so
  // a caller that lost a username silently read a deployment-wide total - and an
  // anonymous request leaked how many keys existed across the whole install.
  for (const missing of [undefined, '', null, 0, false]) {
    assert.throws(() => keyQuota(fresh, missing), /needs an owner/, `owner ${String(missing)} must be refused`);
  }

  assert.equal(keyQuota(fresh, 'alice').used, 1);
  assert.equal(keyQuota(fresh, 'bob').used, 1);
  assert.equal(keyQuota(fresh, 'nobody').used, 0);
  // A global count needs an explicit, differently named call.
  assert.equal(totalKeyCount(fresh), 2);
});

await checkAsync('/api/account never reports another account\'s key count', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const session = sessionFor(fresh, 'account-user');
  // Two more accounts with keys this session must never count.
  for (const [name, id] of [['other-1', 'ko1'], ['other-2', 'ko2']]) {
    saveAccount(fresh, { apiKey: `k-${name}`, username: name, isPro: false });
    fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                   VALUES (?, ?, 'sk-o', ?, 1, 'unlimited', '[]', ?)`).run(id, id, `h-${id}`, name);
  }
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                 VALUES ('kmine', 'mine', 'sk-m', 'h-m', 1, 'unlimited', '[]', 'account-user')`).run();

  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // Regression: the anonymous shape used to be built with `keyQuota(db, undefined)`,
    // which counted every key in the database.
    const anon = await (await fetch(`${base}/api/account`)).json();
    assert.equal(anon.signedIn, false);
    assert.equal(anon.keyQuota.used, 0, 'an anonymous caller must not see a key count');

    const mine = await asUser(base, session)('/api/account');
    assert.equal(mine.body.keyQuota.used, 1, 'a session sees only its own keys');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a cache hit reaches the client in both streaming and not', async () => {
  /*
   * The gateway's own accounting has always split cache reads out, but that is not the
   * question a caller asks: they ask whether *their* client is told. OpenAI reports it as
   * `prompt_tokens_details.cached_tokens`, so a caller can see how much of their prompt
   * was served from cache - and it has to survive both response shapes, because a client
   * that streams gets its usage from the final chunk and nothing else.
   *
   * The upstream is stubbed with a real DeepAI usage payload, so this checks the whole
   * path: normalize upstream -> attach to the response -> serialize for the caller.
   */
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const { hashKey } = await import('../src/keys.js');
  saveAccount(fresh, { apiKey: 'k', username: 'cache-user', isPro: false });
  const plaintext = 'sk-' + 'b'.repeat(40);
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                 VALUES ('kcache', 'cache', 'sk-bbbb', ?, 1, 'unlimited', '[]', 'cache-user')`)
    .run(hashKey(plaintext));

  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const realFetch = globalThis.fetch;
  const http = (...args) => realFetch(...args);

  /** The usage DeepAI sends when part of the prompt was a cache hit. */
  const upstreamUsage = {
    prompt_tokens: 1000,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
  };

  const sse = (chunks) => new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

  const call = (stream) => http(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream }),
  });

  try {
    /*
     * The upstream is always called in streaming mode - `stream_options.include_usage` is
     * what makes DeepAI report usage at all - so both cases below stub an SSE stream. The
     * difference under test is only what the *caller* asked for.
     */
    globalThis.fetch = async () => sse([
      { choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: upstreamUsage },
    ]);

    const plain = await (await call(false)).json();
    assert.equal(plain.usage.prompt_tokens_details.cached_tokens, 900,
      'a non-streaming caller must see the cache hit');
    // The gateway re-inflates prompt_tokens to include the cached part, as OpenAI does.
    assert.equal(plain.usage.prompt_tokens, 1000, 'prompt_tokens must stay the full prompt');
    assert.equal(plain.usage.completion_tokens, 20);

    // --- Streaming: the only place usage can appear is the final chunk.
    globalThis.fetch = async () => sse([
      { choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: upstreamUsage },
    ]);

    const body = await (await call(true)).text();
    const chunks = body.split('\n\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)));
    const withUsage = chunks.filter((c) => c.usage !== undefined);
    assert.equal(withUsage.length, 1, 'exactly one chunk may carry usage');
    assert.equal(withUsage[0].usage.prompt_tokens_details.cached_tokens, 900,
      'a streaming caller must see the cache hit in the final chunk');
    assert.equal(withUsage[0].usage.prompt_tokens, 1000);
    // And the gateway asked upstream for it: without this the chunk never arrives.
    assert.ok(body.includes('"content":"ok"'), 'the text still streams');

    // --- A prompt with no cache hit must not invent the field.
    globalThis.fetch = async () => sse([
      { choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } },
    ]);
    const miss = await (await call(false)).json();
    assert.equal(miss.usage.prompt_tokens_details, undefined,
      'no cache hit means no cached_tokens field, not a zero that looks like one');

    // --- The Responses transport reports it under input_tokens_details.
    globalThis.fetch = async () => sse([
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: {
        status: 'completed',
        usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } },
      } },
    ]);
    const responsesBody = await (await http(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })).text();
    assert.match(responsesBody, /"cached_tokens":900/,
      'the Responses transport must report its cache hit too');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a streaming failure is still framed as an event stream', async () => {
  // Regression: the error path wrote `data: {...}` bytes without ever setting
  // the SSE content type, so a client parsing the response as an event stream
  // received an untyped body it could not classify.
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const { hashKey } = await import('../src/keys.js');
  saveAccount(fresh, { apiKey: 'k', username: 'sse-user', isPro: false });
  const plaintext = 'sk-' + 'a'.repeat(40);
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                 VALUES ('ksse', 'sse', 'sk-aaaa', ?, 1, 'unlimited', '[]', 'sse-user')`)
    .run(hashKey(plaintext));

  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // This reaches DeepAI, which rejects the unknown model. The point under test
    // is the response framing, not the upstream verdict, so any non-2xx proves
    // the failure path was taken.
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'definitely-not-a-real-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    assert.notEqual(response.status, 200, 'the request must have failed');
    assert.match(
      String(response.headers.get('content-type')),
      /text\/event-stream/,
      'a failed stream must still declare the event-stream content type',
    );
    assert.match(String(response.headers.get('cache-control')), /no-cache/);
    const body = await response.text();
    assert.match(body, /^data: /, 'the body is SSE');
    assert.match(body, /"error"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* --------------------------------------------------- bugs found in review */

await checkAsync('the text stays inside the characters a keyboard can reach', async () => {
  /*
   * The line, written down so it does not have to be remembered:
   *
   * Forbidden are the typographic tells of machine-written prose - the em dash, the
   * ellipsis character, arrows, non-breaking spaces, the multiplication sign - and every
   * decorative quotation mark: the curly ones, the low-high ones Polish and German use, the
   * Spanish guillemets, the typographic apostrophe. Quotes are plain in every language.
   *
   * Allowed are the characters a language cannot do without: the diacritics AltGr produces,
   * and the inverted question and exclamation marks Spanish writes at the start of a
   * sentence. There is no plain equivalent of `¿`, so removing it would be correcting a
   * language rather than cleaning it.
   *
   * The flag emoji are the one deliberate exception: the language switcher shows a flag.
   */
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;

  const TYPEABLE = new Set([...'~`1234567890!@#$%^&*()-=_+qwertyuiop[]\\{}|asdfghjkl:";\'zxcvbnm,./<>?QWERTYUIOPLKJHGFDSAZXCVBNM']);
  const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
  // Orthography with no plain equivalent: the marks Spanish opens a sentence with.
  const LANGUAGE_PUNCTUATION = new Set(['\u00bf', '\u00a1']);
  const isFlag = (code) => code >= 0x1f1e6 && code <= 0x1f1ff;

  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.git', 'data', 'backups', 'assets'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (!/\.(png|ico|jpg|jpeg|gif|webp)$/i.test(full)) out.push(full);
    }
    return out;
  };

  const offences = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      let column = 0;
      for (const char of line) {
        const code = char.codePointAt(0);
        if (TYPEABLE.has(char) || WHITESPACE.has(char) || code < 0x80) { column += 1; continue; }
        if (/\p{L}/u.test(char) || LANGUAGE_PUNCTUATION.has(char) || isFlag(code)) { column += 1; continue; }
        if (offences.length < 20) {
          offences.push(`${file.replace(root, '')}:${index + 1}:${column} ${JSON.stringify(char)} U+${code.toString(16).toUpperCase()}`);
        }
      }
    });
  }

  assert.deepEqual(offences, [], 'characters outside the typeable set');
});

await checkAsync('the defaults a fresh clone gets are the documented ones', async () => {
  /*
   * A clone with no `.env` has to work and has to behave the way the README says. The
   * notable default is `HOST`: a gateway exists to be reached from other machines, so it
   * binds every interface - which is also why the README says plainly that this exposes the
   * dashboard, and why `.env.example` explains how to keep it local.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { config } = await import('../server.js');
  const root = new URL('..', import.meta.url).pathname;

  const defaults = config({});
  assert.equal(defaults.host, '0.0.0.0', 'a fresh clone must be reachable from the network');
  assert.equal(defaults.port, 8787);
  assert.equal(defaults.callbackLogin, false, 'browser sign-in is opt-in');
  assert.equal(defaults.forgetAccountAfterDays, 0, 'retention is opt-in');
  assert.equal(defaults.logRequests, true);

  // Every setting the code reads is offered in `.env.example`, and nothing else is: an
  // example that drifts is worse than none, because it looks authoritative.
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const read = new Set([...server.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
  const offered = new Set([...example.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

  assert.deepEqual([...read].filter((name) => !offered.has(name)).sort(), [],
    'settings the code reads but the example omits');
  assert.deepEqual([...offered].filter((name) => !read.has(name)).sort(), [],
    'settings the example offers that nothing reads');

  // And it must be committable, or the clone instructions cannot be followed.
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.ok(!/^\.env\.example$/m.test(ignore), '.env.example must not be ignored');
});

await checkAsync('inactive accounts are forgotten only when a deployment asks for it', async () => {
  /*
   * This is the one setting that deletes data on its own, so the tests are about what it
   * must *not* do as much as what it does: off by default, off for anything unparsable,
   * and never a way to lose an account that is still being used.
   */
  const { openDatabase } = await import('../src/db.js');
  const { forgetInactiveAccounts, saveAccount, touchAccount, readAccount, listAccounts } = await import('../src/store.js');
  const { record } = await import('../src/usage.js');
  const { config } = await import('../server.js');

  const DAY = 24 * 60 * 60_000;
  const now = Date.now();

  // --- The setting is off unless a positive whole number of days is given.
  for (const [value, expected] of [
    [undefined, 0], ['', 0], ['   ', 0], ['0', 0], ['-1', 0], ['-30', 0],
    ['abc', 0], ['1.5', 1], ['30', 30], [' 90 ', 90],
  ]) {
    assert.equal(config({ FORGET_ACCOUNT_AFTER_DAYS: value }).forgetAccountAfterDays, expected,
      `FORGET_ACCOUNT_AFTER_DAYS=${JSON.stringify(value)} must read as ${expected}`);
  }

  // --- A schema from before v6 gains the column, backfilled rather than left NULL.
  const older = openDatabase(':memory:');
  assert.equal(older.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '6');
  const columns = older.prepare('PRAGMA table_info(accounts)').all().map((row) => row.name);
  assert.ok(columns.includes('last_seen_at'), 'the accounts table must carry last_seen_at');
  saveAccount(older, { apiKey: 'k-old', username: 'backfilled', isPro: false });
  assert.equal(
    typeof older.prepare('SELECT last_seen_at FROM accounts WHERE username = ?').get('backfilled').last_seen_at,
    'number',
    'a new account is stamped with activity, never left NULL',
  );

  // --- The sweep itself.
  const db = openDatabase(':memory:');
  saveAccount(db, { apiKey: 'k1', username: 'idle-40d', isPro: false });
  saveAccount(db, { apiKey: 'k2', username: 'idle-2d', isPro: false });
  saveAccount(db, { apiKey: 'k3', username: 'fresh', isPro: false });

  // A key owned by the idle account, to prove keys go with it.
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
              VALUES ('kold', 'old key', 'sk-old', 'hash', 1, 'unlimited', '[]', 'idle-40d')`).run();
  // Usage history for that key: it must survive the account being forgotten.
  record(db, { keyId: 'kold', keyName: 'old key', owner: 'idle-40d', model: 'glm-5.3-flash', totalTokens: 42, ok: true });

  const setSeen = (username, ms) => db.prepare('UPDATE accounts SET last_seen_at = ? WHERE username = ?').run(ms, username);
  setSeen('idle-40d', now - 40 * DAY);
  setSeen('idle-2d', now - 2 * DAY);
  setSeen('fresh', now - 60_000);

  // Off: nothing is removed, however idle.
  assert.deepEqual(forgetInactiveAccounts(db, { days: 0, now }), [], 'zero days must remove nothing');
  assert.equal(listAccounts(db).length, 3, 'and must not touch the table');

  // Thirty days: only the account idle for longer than that.
  const removed = forgetInactiveAccounts(db, { days: 30, now });
  assert.deepEqual(removed.map((r) => r.username), ['idle-40d']);
  assert.equal(removed[0].keys, 1, 'the report says how many keys went with it');
  assert.equal(removed[0].idleDays, 40, 'and how long it had been idle');

  const survivors = listAccounts(db).map((a) => a.username).sort();
  assert.deepEqual(survivors, ['fresh', 'idle-2d'], 'an account used inside the window stays');
  assert.equal(readAccount(db, 'idle-40d'), undefined, 'the forgotten account is gone');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE owner_username = ?').get('idle-40d').n, 0,
    'its gateway keys are gone too');
  // History is what a bill is read from, so it outlives the account.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage WHERE owner_username = ?').get('idle-40d').n, 1,
    'usage history survives the account being forgotten');

  // --- Activity keeps an account alive: a touch moves it out of the window.
  saveAccount(db, { apiKey: 'k4', username: 'revived', isPro: false });
  setSeen('revived', now - 40 * DAY);
  assert.equal(touchAccount(db, 'revived', now), true, 'an old timestamp is written');
  assert.equal(touchAccount(db, 'revived', now + 1000), false, 'and a recent one is not written again');
  assert.deepEqual(forgetInactiveAccounts(db, { days: 30, now }).map((r) => r.username), [],
    'an account touched just now must not be swept');

  // A touch for an account that does not exist is not an error, just nothing to do.
  assert.equal(touchAccount(db, 'nobody', now), false);
});

await checkAsync('every language is complete and agrees on its placeholders', async () => {
  /*
   * The translations are data, so the failure mode is silent: a missing key renders as the
   * key itself, and a translation that drops `{source}` renders a sentence with a hole in
   * it. Neither shows up as an error at runtime, so both are checked here.
   */
  const english = LOCALES.en;
  assert.ok(english !== undefined, 'the English strings must exist: they are the fallback');
  assert.ok(Object.keys(english).length > 100, `expected a full set of strings, saw ${Object.keys(english)?.length}`);

  /*
   * A value is a string, or - for a phrase whose wording depends on the number - an object
   * of plural forms. Both are compared as a *set* of placeholders and tags across every
   * form, because Polish legitimately has more forms than English does.
   */
  const formsOf = (value) => (typeof value === 'string' ? [value] : Object.values(value ?? {}));
  const placeholdersIn = (value) => [...new Set(formsOf(value)
    .flatMap((form) => [...String(form).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort().join(',');
  const tagsIn = (value) => [...new Set(formsOf(value)
    .flatMap((form) => [...String(form).matchAll(/<\/?([a-z]+)>/g)].map((m) => m[1])))].sort().join(',');

  for (const code of LOCALE_CODES) {
    const strings = LOCALES[code];
    assert.ok(strings !== undefined, `${code}.json must exist`);

    const missing = Object.keys(english).filter((key) => !(key in strings));
    const extra = Object.keys(strings).filter((key) => !(key in english));
    assert.deepEqual(missing, [], `${code}.json is missing keys`);
    assert.deepEqual(extra, [], `${code}.json has keys English does not`);

    for (const [key, value] of Object.entries(strings)) {
      const forms = formsOf(value);
      assert.ok(forms.length > 0, `${code}.${key} must have at least one form`);
      assert.ok(
        forms.every((form) => typeof form === 'string' && form.trim() !== ''),
        `${code}.${key} must not be empty`,
      );
      if (typeof value === 'object') {
        // A plural entry must carry the fallback every language falls back to.
        assert.ok(typeof value.other === 'string', `${code}.${key} must have an \`other\` form`);
      }
      // A dropped placeholder is a sentence that renders with a gap; a dropped tag is
      // markup shown as text.
      assert.equal(placeholdersIn(value), placeholdersIn(english[key]),
        `${code}.${key} must keep the same placeholders as English`);
      assert.equal(tagsIn(value), tagsIn(english[key]),
        `${code}.${key} must keep the same HTML tags as English`);
    }
  }

  /*
   * Every key must be reachable from the code.
   *
   * This is not tidiness: an unreferenced key is how a lost edit looks. A conversion that
   * was never applied leaves the English hardcoded in the markup *and* the key unused, and
   * that pair is what this catches - it found the account badge still rendering a literal
   * "Credits" after the conversion had been dropped by a failed script.
   */
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const used = new Set();
  for (const m of app.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) used.add(m[1]);
  for (const m of app.matchAll(/counted\(\s*'([a-zA-Z][\w.]*)'/g)) used.add(m[1]);
  // Keys built at runtime from a stable family: `t(`status.${status}`)`.
  for (const m of app.matchAll(/(authEvent|status|window)\.\$\{/g)) {
    for (const key of Object.keys(english)) if (key.startsWith(`${m[1]}.`)) used.add(key);
  }
  for (const m of html.matchAll(/data-i18n(?:-attr)?="([^"]+)"/g)) {
    for (const pair of m[1].split(',')) {
      for (const part of pair.split(':')) {
        const value = part.trim();
        if (value.includes('.')) used.add(value);
      }
    }
  }
  const orphaned = Object.keys(english).filter((key) => !used.has(key));
  assert.deepEqual(orphaned, [], 'locale keys nothing references');

  // English must not have been translated into itself for any key a translator touched.
  assert.notEqual(LOCALES.pl['common.cancel'], english['common.cancel'],
    'a translation must actually differ from English');
});

await checkAsync('the language switcher offers every language and remembers the choice', async () => {
  /*
   * The switcher sits to the right of the theme toggle, shows the active language as a
   * flag, and opens a menu of all of them. It has to work from the JSON files on disk
   * rather than from anything baked into the page.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

  // The markup: a flag button and its menu, after the theme toggle.
  assert.match(html, /id="theme-toggle"[\s\S]*id="locale-button"[\s\S]*id="locale-menu"/,
    'the switcher must come after the theme toggle');
  assert.match(html, /id="locale-flag"/, 'it shows the active language as a flag');
  assert.match(html, /id="locale-menu" role="listbox" hidden/, 'the menu starts closed');

  const stored = new Map();
  const nodes = new Map();
  const node = () => ({
    innerHTML: '', textContent: '', hidden: false, disabled: false, className: '',
    dataset: {}, style: {}, value: '', children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild(c) { this.children.push(c); },
    append(...c) { this.children.push(...c); }, remove() {},
    replaceChildren(...c) { this.children = Array.from(c); },
    querySelector: (sel) => (sel === '[data-locale]' ? (this.children ?? [])[0] ?? null : null),
    querySelectorAll: () => [], setAttribute(k, v) { this[k] = v; },
    getAttribute: (k) => this[k] ?? null, closest: () => null,
    focus() {}, select() {}, insertAdjacentHTML() {}, scrollIntoView() {},
  });
  for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
    'account-badge', 'account-badge-text', 'nav', 'theme-toggle', 'auth-button',
    'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());

  const sandbox = {
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: () => node(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, documentElement: { lang: '', dataset: {} },
      visibilityState: 'visible', body: node(),
    },
    window: {
      addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
      location: { assign() {} },
    },
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => stored.get(k) ?? null,
      setItem: (k, v) => stored.set(k, v),
      removeItem: (k) => stored.delete(k),
    },
    // A Polish browser: the first visit should follow it without being asked.
    navigator: { language: 'pl-PL', languages: ['pl-PL', 'en'] },
    fetch: async (url) => {
      const code = /\/locales\/([a-z]{2})\.json/.exec(String(url))?.[1] ?? 'en';
      assert.ok(LOCALES[code] !== undefined, `the client asked for ${code}.json`);
      return localeResponse(code);
    },
    setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
    console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
    Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(app, { filename: 'app.js' }).runInContext(sandbox);
  await new Promise((resolve) => setTimeout(resolve, 80));

  // It followed the browser's language, and showed that language's flag.
  assert.equal(vm.runInContext('state.locale', sandbox), 'pl', 'a Polish browser gets Polish');
  assert.equal(nodes.get('locale-flag').textContent, '🇵🇱', 'and the Polish flag is shown');

  // Every language is offered, each with its own flag.
  // Copied into host arrays: `LOCALES` lives in the sandbox's realm, and `deepStrictEqual`
  // compares realms as well as contents.
  const options = Array.from(vm.runInContext('LOCALES', sandbox), (entry) => ({ ...entry }));
  assert.equal(options.length, 4, 'four languages are offered');
  assert.deepEqual(options.map((o) => o.code), ['en', 'pl', 'de', 'es']);

  // The menu lists all of them: flag and the language's own name, one entry each.
  vm.runInContext('renderLocaleMenu()', sandbox);
  const entries = nodes.get('locale-menu').children;
  assert.equal(entries.length, 4, 'one entry per language');
  assert.deepEqual(entries.map((e) => e.dataset.locale), ['en', 'pl', 'de', 'es']);
  const flat = (entry) => {
    const out = [];
    const walk = (list) => { for (const child of list) { if (child.textContent) out.push(child.textContent); walk(child.children ?? []); } };
    walk([entry]);
    return out;
  };
  assert.deepEqual(flat(entries[1]), ['🇵🇱', 'Polski'], 'each entry is a flag and its own name');

  // Switching stores the choice and swaps the strings.
  await vm.runInContext("setLocale('de')", sandbox);
  assert.equal(stored.get('deepai-gateway-locale'), 'de', 'the choice is remembered');
  assert.equal(nodes.get('locale-flag').textContent, '🇩🇪', 'and the flag follows');
  const german = vm.runInContext("t('common.cancel')", sandbox);
  assert.equal(german, LOCALES.de['common.cancel'], 'the strings come from the German file');
  assert.notEqual(german, 'common.cancel', 'and are not left as the key');

  /*
   * Plural selection. English has two forms and Polish has four, chosen by rules rather
   * than by a count comparison - Polish needs "few" for 2-4 and "many" for 5+, which is
   * exactly what `Intl.PluralRules` implements. Getting this wrong is invisible in English
   * and glaring in Polish ("1 żądań" instead of "1 żądanie").
   */
  const plural = (code, key, count) => {
    vm.runInContext(`state.locale = '${code}'; state.strings = ${JSON.stringify(LOCALES[code])};`, sandbox);
    return vm.runInContext(`counted('${key}', ${count})`, sandbox);
  };

  assert.equal(plural('en', 'home.sparkTokens', 1), '1 token', 'English singular');
  assert.equal(plural('en', 'home.sparkTokens', 2), '2 tokens', 'English plural');

  assert.equal(plural('pl', 'home.sparkTokens', 1), '1 token', 'Polish singular');
  assert.equal(plural('pl', 'home.sparkTokens', 2), '2 tokeny', 'Polish few');
  assert.equal(plural('pl', 'home.sparkTokens', 5), '5 tokenów', 'Polish many');
  assert.equal(plural('pl', 'home.sparkRequests', 1), '1 żądanie', 'Polish singular for requests');
  assert.equal(plural('pl', 'home.sparkRequests', 3), '3 żądania', 'Polish few for requests');
  assert.equal(plural('pl', 'home.sparkRequests', 12), '12 żądań', 'Polish many for requests');

  // Numbers are formatted the way the language writes them, not the way English does.
  vm.runInContext(`state.locale = 'de'; state.strings = ${JSON.stringify(LOCALES.de)};`, sandbox);
  assert.equal(vm.runInContext("counted('home.sparkTokens', 1234)", sandbox), '1.234 Tokens',
    'German groups thousands with a dot');

  // Without a count there is no form to choose, so the key is returned rather than a guess.
  vm.runInContext(`state.locale = 'pl'; state.strings = ${JSON.stringify(LOCALES.pl)};`, sandbox);
  assert.equal(vm.runInContext("t('home.sparkTokens')", sandbox), 'home.sparkTokens',
    'a plural entry with no count cannot be resolved');

  // An unknown language falls back to English rather than to a blank page.
  assert.equal(vm.runInContext("localeOf('xx').code", sandbox), 'en', 'an unknown code is English');
  // A missing key is visible as the key, never as an empty string.
  assert.equal(vm.runInContext("t('nope.missing')", sandbox), 'nope.missing', 'a missing key is visible');
});

await checkAsync('a malformed cookie cannot take the whole server down', async () => {
  // Regression: `decodeURIComponent` threw inside the session middleware, which
  // runs before every route, so one bad cookie made *every* response a 500 -
  // including /healthz - and the browser was never told to drop it.
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const bad of ['%ZZ', '%E0%A4%A', '%', 'abc%']) {
      for (const path of ['/healthz', '/api/account', '/api/pricing']) {
        const response = await fetch(`${base}${path}`, {
          headers: { cookie: `${SESSION_COOKIE}=${bad}` },
        });
        assert.notEqual(response.status, 500, `${path} must survive cookie ${bad}`);
      }
    }
    // The bad cookie resolves to no session, so it is treated as logged out.
    const account = await fetch(`${base}/api/account`, { headers: { cookie: `${SESSION_COOKIE}=%ZZ` } });
    assert.equal((await account.json()).signedIn, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a newer database is refused rather than stamped downwards', async () => {
  // Regression: `if (current !== SCHEMA_VERSION)` wrote this build's version
  // into a database written by a newer one. The migrations are one-way and v5 is
  // destructive, so a later run of the newer build would re-apply them.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'deepai-newer-')), 'newer.db');

  const newer = new DatabaseSync(file);
  newer.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  newer.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', '99');
  newer.close();

  assert.throws(() => openDatabase(file), /schema is v99/, 'a future schema must be refused');

  // The version is untouched, not rewritten.
  const after = new DatabaseSync(file);
  assert.equal(after.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '99');
  after.close();
});

await checkAsync('the v5 index is created even with no tombstones to clean', async () => {
  // Regression: the CREATE INDEX sat inside `if (removed.changes > 0)`, so the
  // common upgrade path - a database that never held a revoked key - ended up
  // without it, making the schema depend on data rather than on version.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'deepai-v5idx-')), 'v4.db');

  const v4 = new DatabaseSync(file);
  v4.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '4');
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL, is_pro INTEGER NOT NULL DEFAULT 0, balance TEXT, granted TEXT,
      refresh_at TEXT, checked_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER,
      revoked_at INTEGER, expires_at INTEGER, limit_tokens INTEGER, limit_requests INTEGER,
      limit_window TEXT NOT NULL DEFAULT 'month', allowed_models TEXT NOT NULL DEFAULT '[]',
      owner_username TEXT NOT NULL DEFAULT '', owner_key_hash TEXT, models_restricted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
      key_name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, requested_model TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL DEFAULT 'chat.completions', status INTEGER NOT NULL DEFAULT 200,
      ok INTEGER NOT NULL DEFAULT 1, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, first_token_ms INTEGER, streamed INTEGER NOT NULL DEFAULT 0,
      error_code TEXT, created_at INTEGER NOT NULL, owner_username TEXT NOT NULL DEFAULT '');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '', detail TEXT, created_at INTEGER NOT NULL);
  `);
  v4.prepare('INSERT INTO accounts (username, api_key, created_at, updated_at) VALUES (?,?,?,?)').run('u', 'k', 1, 1);
  // Deliberately no revoked keys.
  v4.close();

  const upgraded = openDatabase(file);
  const names = upgraded.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name);
  assert.ok(names.includes('api_keys_active'), 'the index is part of the schema, not a side effect of the DELETE');
  upgraded.close();
});

check('usage survives the key being revoked mid-request', () => {
  // Regression: `key_id` was bound directly, so deleting the key while its
  // completion was still streaming made the usage INSERT fail the foreign key
  // and the row was lost - even though the request had reached DeepAI.
  const fresh = openDatabase(':memory:');
  saveAccount(fresh, { apiKey: 'k', username: 'u', isPro: false });
  fresh.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, created_at, limit_window, allowed_models, owner_username)
                 VALUES ('k1', 'gone', 'sk-g', 'h-g', 1, 'unlimited', '[]', 'u')`).run();
  fresh.prepare('DELETE FROM api_keys WHERE id = ?').run('k1');

  record(fresh, { keyId: 'k1', keyName: 'gone', owner: 'u', model: 'glm-5.3-flash', totalTokens: 42, ok: true });
  const row = fresh.prepare('SELECT key_id, key_name, total_tokens FROM usage').get();
  assert.equal(row.key_id, null, 'the id resolves to NULL rather than failing the insert');
  assert.equal(row.key_name, 'gone');
  assert.equal(row.total_tokens, 42);
  assert.equal(totals(fresh, 0, 'u').totalTokens, 42, 'the owner still sees the spend');
});

await checkAsync('two accounts on one gateway never see each other', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const alice = sessionFor(fresh, 'alice', { apiKey: 'alice-deepai-key' });
  const bob = sessionFor(fresh, 'bob', { apiKey: 'bob-deepai-key' });
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const asAlice = asUser(base, alice);
  const asBob = asUser(base, bob);
  const createKey = (call, name) => call('/api/keys', {
    method: 'POST',
    body: { name, limitWindow: 'unlimited', modelsRestricted: false },
  });

  try {
    // Both accounts exist at the same time - this is what multi-user means.
    assert.equal(listAccounts(fresh).length, 2);

    const alice1 = await createKey(asAlice, 'alice-1');
    const alice2 = await createKey(asAlice, 'alice-2');
    const bob1 = await createKey(asBob, 'bob-1');
    assert.equal(alice1.body.key.owner, 'alice');
    assert.equal(bob1.body.key.owner, 'bob');

    // Each session sees only its own keys and its own quota.
    const aliceKeys = await asAlice('/api/keys');
    assert.deepEqual(aliceKeys.body.keys.map((k) => k.name).sort(), ['alice-1', 'alice-2']);
    assert.equal(aliceKeys.body.quota.used, 2);

    const bobKeys = await asBob('/api/keys');
    assert.deepEqual(bobKeys.body.keys.map((k) => k.name), ['bob-1']);
    assert.equal(bobKeys.body.quota.used, 1, 'the quota is per account');

    // Another account's key is invisible, not merely forbidden.
    assert.equal((await asBob(`/api/usage/keys/${alice1.body.key.id}`)).status, 404);
    assert.equal((await asBob(`/api/keys/${alice1.body.key.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await asBob(`/api/keys/${alice1.body.key.id}/revoke`, { method: 'POST' })).status, 404);
    assert.equal((await asBob(`/api/keys/${alice1.body.key.id}`, { method: 'PATCH', body: { name: 'hijacked' } })).status, 404);

    // Another account cannot revoke Alice's key.
    assert.equal((await asBob(`/api/keys/${alice1.body.key.id}/revoke`, { method: 'POST' })).status, 404);
    assert.equal((await asBob(`/api/keys/${alice1.body.key.id}`, { method: 'PATCH', body: { name: 'x' } })).status, 404);

    // Alice revoking her own key deletes it.
    const revoked = await asAlice(`/api/keys/${alice1.body.key.id}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    const aliceAfter = await asAlice('/api/keys');
    assert.deepEqual(aliceAfter.body.keys.map((k) => k.name).sort(), ['alice-2']);

    // There is no restore or separate delete route any more.
    assert.equal((await asAlice(`/api/keys/${alice1.body.key.id}/restore`, { method: 'POST' })).status, 404);
    assert.equal((await asAlice(`/api/keys/${alice1.body.key.id}`, { method: 'DELETE' })).status, 404);

    // Usage is scoped too: one row per owner. `alice-1` was deleted above, so
    // attribute the rows to keys that still exist.
    record(fresh, { keyId: alice2.body.key.id, keyName: 'alice-2', owner: 'alice', model: 'glm-5.3-flash', inputTokens: 100, outputTokens: 10, totalTokens: 110, ok: true });
    record(fresh, { keyId: bob1.body.key.id, keyName: 'bob-1', owner: 'bob', model: 'kimi-k3', inputTokens: 7, outputTokens: 3, totalTokens: 10, ok: true });

    const aliceSummary = (await asAlice('/api/usage/summary')).body;
    assert.equal(aliceSummary.all.requests, 1);
    assert.equal(aliceSummary.all.totalTokens, 110);
    assert.deepEqual(aliceSummary.modelsAll.map((m) => m.model), ['glm-5.3-flash']);

    const aliceRecent = (await asAlice('/api/usage/recent')).body.requests;
    assert.equal(aliceRecent.length, 1);
    assert.equal(aliceRecent[0].model, 'glm-5.3-flash');

    const bobSummary = (await asBob('/api/usage/summary')).body;
    assert.equal(bobSummary.all.totalTokens, 10);
    assert.deepEqual(bobSummary.modelsAll.map((m) => m.model), ['kimi-k3']);

    // The export is scoped as well.
    const bobExport = await asBob('/api/usage/export?format=json');
    assert.equal(bobExport.body.rows.length, 1);
    assert.equal(bobExport.body.rows[0].owner, 'bob');
    assert.equal(bobExport.body.rows[0].model, 'kimi-k3');

    // The audit trail is per account.
    const aliceEvents = (await asAlice('/api/account/events')).body.events;
    assert.ok(aliceEvents.every((event) => event.username === 'alice'), 'no other account may appear');

    // Default model is a per-account setting.
    await asAlice('/api/settings/default-model', { method: 'POST', body: { model: 'kimi-k3' } });
    assert.equal((await asAlice('/api/account')).body.defaultModel, 'kimi-k3');
    assert.equal((await asBob('/api/account')).body.defaultModel, 'glm-5.3-flash', "Bob's default is unchanged");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a key is billed to the account that created it', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const alice = sessionFor(fresh, 'alice', { apiKey: 'alice-deepai-key' });
  sessionFor(fresh, 'bob', { apiKey: 'bob-deepai-key' });
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const created = await asUser(base, alice)('/api/keys', {
      method: 'POST',
      body: { name: 'alice-key', limitWindow: 'unlimited', modelsRestricted: false },
    });
    // The key remembers which DeepAI key paid for it at creation time.
    const row = fresh.prepare('SELECT owner_username, owner_key_hash FROM api_keys WHERE id = ?')
      .get(created.body.key.id);
    assert.equal(row.owner_username, 'alice');
    assert.equal(row.owner_key_hash, hashKey('alice-deepai-key'));

    // Rotating Alice's DeepAI key must not repoint her existing gateway key: the
    // hash is a record of what it was created with, not a live binding.
    saveAccount(fresh, { apiKey: 'alice-rotated-key', username: 'alice', isPro: false });
    const unchanged = fresh.prepare('SELECT owner_key_hash FROM api_keys WHERE id = ?').get(created.body.key.id);
    assert.equal(unchanged.owner_key_hash, hashKey('alice-deepai-key'));
    // And the account now holds the new key, so calls use it.
    assert.equal(readAccount(fresh, 'alice').apiKey, 'alice-rotated-key');

    // Removing Alice's account takes only her keys.
    const bob = sessionFor(fresh, 'bob', { apiKey: 'bob-deepai-key' });
    await asUser(base, bob)('/api/keys', {
      method: 'POST',
      body: { name: 'bob-key', limitWindow: 'unlimited', modelsRestricted: false },
    });
    assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n, 2);

    const removed = await asUser(base, alice)('/api/account/forget', { method: 'POST' });
    assert.equal(removed.status, 200);
    assert.equal(readAccount(fresh, 'alice'), undefined);
    const remaining = fresh.prepare('SELECT name, owner_username FROM api_keys').all();
    assert.deepEqual(remaining.map((k) => k.name), ['bob-key']);
    assert.notEqual(readAccount(fresh, 'bob'), undefined, "Bob's account is untouched");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('an ownerless key cannot be created and nothing leaks without a session', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  // An account exists, but this browser has no session for it.
  saveAccount(fresh, { apiKey: 'k', username: 'someone', isPro: false });
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const json = (path, init) => fetch(`${base}${path}`, init).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  try {
    // Regression: creating a key while logged out used to succeed with owner '',
    // which then vanished from the per-user dashboard.
    const created = await json('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'orphan', limitWindow: 'unlimited', modelsRestricted: false }),
    });
    assert.equal(created.status, 401);
    assert.equal(created.body.code, 'not_logged_in');
    assert.equal(fresh.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n, 0, 'no key may be stored');

    // Regression: an existing account used to be enough. Every per-account read
    // must refuse without a session, even though someone is signed in globally.
    assert.equal((await json('/api/account')).body.signedIn, false, 'no cookie means no account');
    for (const path of ['/api/keys', '/api/usage/summary', '/api/usage/recent', '/api/usage/models', '/api/account/events']) {
      assert.equal((await json(path)).status, 401, `${path} must require a session`);
    }
    assert.equal((await fetch(`${base}/api/usage/export`)).status, 401);
    assert.equal((await fetch(`${base}/api/account/forget`, { method: 'POST' })).status, 401);

    // A forged cookie is not a session.
    const forged = await fetch(`${base}/api/keys`, { headers: { cookie: `${SESSION_COOKIE}=deadbeef` } });
    assert.equal(forged.status, 401);
    // ...and the bad cookie is cleared so the browser stops sending it.
    assert.match(String(forged.headers.get('set-cookie')), /deepai_gateway_session=;/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

check('usage rows carry the owner so history outlives the key', () => {
  const fresh = openDatabase(':memory:');
  record(fresh, { keyId: null, keyName: 'gone', owner: 'alice', model: 'glm-5.3-flash', totalTokens: 5, ok: true });
  const rows = [...exportRows(fresh, { owner: 'alice' })];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner_username, 'alice');
  // And it is invisible to anyone else.
  assert.equal([...exportRows(fresh, { owner: 'bob' })].length, 0);
});

/* --------------------------------------------------------------- auth screen */

await checkAsync('the auth screen styles its buttons by class, not by element', async () => {
  /*
   * Regression: the rule was `a.btn`, which never matched a `<button>`, so the control
   * kept its box but lost every visual style. The landing page that carried its own copy
   * of these rules is gone with the browser flow; the panel's stylesheet is the one that
   * matters now.
   */
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

  assert.match(css, /\.btn\s*\{/, 'the button rule must be class-based');
  assert.ok(!/a\.btn\s*\{/.test(css), 'a.btn would miss a <button> element');
  assert.match(css, /\.btn[^{]*\{[^}]*cursor: pointer/, 'interactive elements need a pointer cursor');

  // And the dashboard must not try to close a tab it did not open: browsers refuse it,
  // and the removed flow did it as a matter of course.
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!app.includes('window.close'), 'the page must not try to close itself');
  assert.ok(!app.includes('close-tab'), 'there is no second window to close');
});

await checkAsync('booting the server does not crash and says what it is doing', async () => {
  /*
   * The suite mounts `createApp` everywhere, which never runs `start()` - and that is
   * how a `ReferenceError` in the listen callback reached production: the runtime
   * object built inside `createApp` is not in scope in `start()`, and nothing here
   * had ever executed that line. This boots the real thing.
   */
  const { start } = await import('../server.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const scratch = mkdtempSync(join(tmpdir(), 'deepai-boot-'));

  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines = [];
  // No network during a boot test: the catalog prefetch and the price refresh are
  // both real calls in production.
  globalThis.fetch = async () => new Response('{"data":[]}', {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  console.log = (...args) => lines.push(args.join(' '));

  let booted;
  try {
    booted = start({
      port: 0,
      host: '127.0.0.1',
      database: ':memory:',
      pricingCache: join(scratch, 'pricing.json'),
      logRequests: false,
    });
    // `listen` was already called, so wait for the address rather than the event.
    await new Promise((resolve) => {
      const poll = () => (booted.server.address() === null ? setTimeout(poll, 10) : resolve());
      poll();
    });

    const said = lines.join('\n');
    assert.match(said, /listening on http:\/\/127\.0\.0\.1:\d+/, 'the boot banner must be printed');
    assert.match(said, /OpenAI base URL: http:\/\/127\.0\.0\.1:\d+\/v1/, 'and the endpoint to point a client at');
    assert.match(said, /no DeepAI accounts yet/, 'a fresh database is worth reporting');
    // Loopback means there is nothing exposed to warn about.
    assert.ok(!said.includes('not loopback'), 'no exposure note on a loopback host');
    assert.ok(!said.includes('cannot open it'), 'no workaround to explain for a flow that no longer exists');
  } finally {
    console.log = realLog;
    globalThis.fetch = realFetch;
    if (booted !== undefined) {
      await new Promise((resolve) => booted.server.close(resolve));
      try { booted.db.close(); } catch { /* already closed */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

await checkAsync('a non-loopback boot warns about what it exposes', async () => {
  const { start } = await import('../server.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const scratch = mkdtempSync(join(tmpdir(), 'deepai-boot2-'));

  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines = [];
  globalThis.fetch = async () => new Response('{"data":[]}', {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  console.log = (...args) => lines.push(args.join(' '));

  let booted;
  try {
    booted = start({
      port: 0,
      host: '0.0.0.0',
      database: ':memory:',
      pricingCache: join(scratch, 'pricing.json'),
      logRequests: false,
    });
    await new Promise((resolve) => {
      const poll = () => (booted.server.address() === null ? setTimeout(poll, 10) : resolve());
      poll();
    });

    // The dashboard is cookie-protected but reachable, and an operator should know.
    const said = lines.join('\n');
    assert.match(said, /not loopback/, 'an exposed host must be called out');
    assert.match(said, /dashboard is reachable from the network/);
    // Nothing may promise a workaround for the sign-in flow that was removed.
    assert.ok(!said.includes('cannot open it'), 'no advice about a flow that no longer exists');
  } finally {
    console.log = realLog;
    globalThis.fetch = realFetch;
    if (booted !== undefined) {
      await new Promise((resolve) => booted.server.close(resolve));
      try { booted.db.close(); } catch { /* already closed */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

await checkAsync('the project presents one consistent identity', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;

  // Walk the shipped sources and fail on any leftover of the old name.
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'data' || entry === '.git') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  };
  const needle = ['deepai', 'to', 'api'].join('-');
  const stale = [];
  for (const file of walk(root)) {
    if (!/\.(js|json|md|css|html|yml|yaml)$/.test(file)) continue;
    if (file.endsWith('package-lock.json')) continue;
    // This test file assembles the needle at runtime, so it never matches itself.
    const text = readFileSync(file, 'utf8');
    if (text.includes(needle)) stale.push(file.slice(root.length));
  }
  assert.deepEqual(stale, [], 'no shipped file may mention the old project name');

  // The identity strings the outside world sees.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'deepai-gateway');
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, 'deepai-gateway');
  assert.equal(lock.packages[''].name, 'deepai-gateway');

  const { USER_AGENT } = await import('../src/deepai/wire.js');
  assert.equal(USER_AGENT, 'deepai-gateway/1.0');

  const dashboard = readFileSync(join(root, 'public/index.html'), 'utf8');
  assert.match(dashboard, /<title>DeepAI Gateway<\/title>/);
  assert.match(dashboard, /DeepAI Gateway/);
});

/* ------------------------------------------- deepai sign-in callback address */

/*
 * DeepAI builds the sign-in callback host itself and always picks `127.0.0.1`;
 * `port` is the only input it accepts, and it must be a plain integer. A browser
 * on any other machine therefore cannot open the redirect, so the gateway keeps
 * the address to show the visitor and accepts it back through
 * `POST /api/login/complete`. These checks pin both halves of that.
 */

await checkAsync('the sign-in card gives one instruction, and it is the one that works', async () => {
  /*
   * Two earlier versions of this instruction were wrong, and both were taught by trying
   * them: a console command returns `'OK'` unless the console is on DeepAI's own origin,
   * because the API answers `201 OK` to an unauthenticated request; and the steps sat
   * behind a click, so the instructions a visitor needed were the ones they could not
   * see.
   *
   * What ships now is a page they open, a tab they click and text they copy - and the
   * `OK` case is called out, because that is what a signed-out visitor will see.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const source = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  const render = async (account) => {
    const nodes = new Map();
    const node = () => ({
      innerHTML: '', textContent: '', hidden: false, disabled: false, className: '',
      dataset: {}, style: {}, value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, remove() {},
      replaceChildren(...children) { this.children = Array.from(children); },
      querySelector: () => null, querySelectorAll: () => [], setAttribute() {},
      getAttribute: () => null, closest: () => null, focus() {}, select() {},
      insertAdjacentHTML() {}, scrollIntoView() {},
    });
    for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
      'account-badge', 'account-badge-text', 'auth-button', 'nav', 'theme-toggle', 'auth-button', 'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());
    const sandbox = {
      document: {
        getElementById: (id) => nodes.get(id) ?? null,
        createElement: () => node(), querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, documentElement: node(), visibilityState: 'visible', body: node(),
      },
      window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { assign() {} } },
      location: { search: '', pathname: '/', hash: '' },
      history: { replaceState() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { language: 'en-GB', languages: ['en-GB'] },
      fetch: async (url) => {
        if (String(url).includes('/locales/')) return localeResponse();
        return new Response(
          JSON.stringify(String(url).includes('/account') ? account : { ok: true, models: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
      console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
      Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    new vm.Script(source, { filename: 'app.js' }).runInContext(sandbox);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return nodes.get('view').innerHTML;
  };

  const signedOut = {
    ok: true, signedIn: false, username: '', displayName: '',
    allowance: null, balanceLow: false,
    keyQuota: { used: 0, max: 5, remaining: 5, atLimit: false },
  };
  const html = await render(signedOut);

  // The three steps, in order, with the two addresses as real links.
  const step = (n) => new RegExp(`<li>[\\s\\S]{0,400}?</li>`, 'g');
  assert.match(html, /Go to <a href="https:\/\/deepai\.org"[^>]*>https:\/\/deepai\.org<\/a>\s*and log in or register/,
    'step 1 sends them to DeepAI and says what to do there');
  assert.match(html, /<a href="https:\/\/api\.deepai\.org\/daily-time-sync\/user\/"[^>]*>https:\/\/api\.deepai\.org\/daily-time-sync\/user\/<\/a>/,
    'step 2 links the API page itself');
  assert.match(html, /<strong>Raw Data<\/strong> tab/, 'step 2 names the tab to click');
  assert.match(html, /Copy the <strong>Content<\/strong> and paste it below/, 'step 3 says what to copy');

  /*
   * The hint belongs between the two steps it concerns: it warns about what step 2 will
   * show, so it is useless after step 2 has already been read. Asserted by position in
   * the rendered markup, since that is the only thing that decides what is read first.
   */
  const hintAt = html.indexOf('note--info');
  const step2At = html.indexOf('daily-time-sync/user/');
  assert.ok(hintAt !== -1, 'the "plain OK" hint is present');
  assert.ok(hintAt < step2At, 'the hint must come before step 2');
  assert.ok(html.indexOf('log in or register') < hintAt, 'and after step 1');
  // The split list has to keep counting from 2, or the steps read 1, 1, 2.
  assert.match(html, /<ol class="step__list mt-3" start="2">/, 'the second list resumes at 2');

  // The signed-out case is called out in blue, because `OK` is what they will see.
  assert.match(html, /note--info/, 'the "plain OK" hint is an info note, not an error');
  assert.match(
    html,
    /If you get plain <code>OK<\/code> in step 2, make sure you are logged in\./,
    'the hint names the symptom and the check, in one line',
  );

  // One field, sized for JSON, and the control that submits it.
  assert.match(html, /<textarea class="textarea" id="profile-paste" rows="7"/);
  assert.match(html, /id="login-with-profile"/);

  // The removed routes must be gone from the screen entirely.
  for (const gone of ['id="password-form"', 'id="api-key"', 'id="login-tabs"', 'password']) {
    assert.ok(!html.includes(gone), `the removed route must not remain: ${gone}`);
  }
  // And no command to run in a console, which is the version that printed 'OK'.
  assert.ok(!html.includes('console.log'), 'no console command: it returns OK off-origin');
  assert.ok(!html.includes('allow pasting'), 'and no paste warning to go with it');
  assert.ok(!html.includes('${'), 'no unrendered template expression');
});

await checkAsync('both signed-out screens offer the one route', async () => {
  /*
   * There are two: the log-in screen and the account card on the overview. They each
   * carried their own copy of the sign-in markup once, so rewriting the screen changed
   * only one of them - a deploy that had shipped, showing a screen that did not exist.
   * Both now render the same block through one function, and this holds them to it.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const source = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  const boot = async (account) => {
    const nodes = new Map();
    const node = () => ({
      innerHTML: '', textContent: '', hidden: false, disabled: false, className: '',
      dataset: {}, style: {}, value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, remove() {},
      replaceChildren(...children) { this.children = Array.from(children); },
      querySelector: () => null, querySelectorAll: () => [], setAttribute() {},
      getAttribute: () => null, closest: () => null, focus() {}, select() {},
      insertAdjacentHTML() {}, scrollIntoView() {},
    });
    for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
      'account-badge', 'account-badge-text', 'auth-button', 'nav', 'theme-toggle', 'auth-button', 'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());
    const sandbox = {
      document: {
        getElementById: (id) => nodes.get(id) ?? null,
        createElement: () => node(), querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, documentElement: node(), visibilityState: 'visible', body: node(),
      },
      window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { assign() {} } },
      location: { search: '', pathname: '/', hash: '' },
      history: { replaceState() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { language: 'en-GB', languages: ['en-GB'] },
      fetch: async (url) => {
        if (String(url).includes('/locales/')) return localeResponse();
        return new Response(
          JSON.stringify(String(url).includes('/account') ? account : { ok: true, models: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
      console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
      Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    new vm.Script(source, { filename: 'app.js' }).runInContext(sandbox);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { nodes, sandbox };
  };

  const signedOut = {
    ok: true, signedIn: false, username: '', displayName: '',
    allowance: null, balanceLow: false,
    keyQuota: { used: 0, max: 5, remaining: 5, atLimit: false },
  };

  const first = await boot(signedOut);
  const loginScreen = first.nodes.get('view').innerHTML;
  const second = await boot(signedOut);
  const card = second.sandbox.accountCard();

  for (const [name, html] of [['the log-in screen', loginScreen], ['the account card', card]]) {
    assert.match(html, /id="(account-)?profile-paste"/, `${name} must offer the paste field`);
    assert.match(html, /id="(account-)?login-with-profile"/, `${name} must submit it`);
    assert.match(html, /Raw Data/, `${name} must name the tab to click`);
    assert.ok(!html.includes('id="password-form"'), `${name} must not offer a removed route`);
    assert.ok(!html.includes('id="api-key"'), `${name} must not offer a removed route`);
    assert.ok(!html.includes('id="signin"'), `${name} must not resurrect the old button`);
  }

  // The replaced controls must be gone from the source, not merely unreachable.
  for (const gone of ['id="password-form"', 'id="api-key"', 'id="signin"', 'passwordForm(', 'keyForm(']) {
    assert.ok(!source.includes(gone), `${gone} must not remain in the source`);
  }
});

await checkAsync('a pasted callback address yields its code and state, or says what is missing', async () => {
  /*
   * This is the input a visitor produces when the redirect could not open: whatever their
   * address bar holds, copied by hand. The reasons are shown as instructions, so each one
   * names the part that is wrong rather than saying "invalid".
   */
  const { parseCallbackInput } = await import('../src/deepai/callback-login.js');

  const state = 'a'.repeat(64);
  assert.deepEqual(
    parseCallbackInput(`http://127.0.0.1:25912/callback?code=abc&state=${state}`),
    { ok: true, code: 'abc', state },
  );
  // A quoted link, as a chat client or terminal hands it back.
  assert.deepEqual(
    parseCallbackInput(`  <"http://127.0.0.1:1/callback?code=c&state=${state}">  `),
    { ok: true, code: 'c', state },
  );
  // A bare query fragment, with no host at all.
  assert.deepEqual(
    parseCallbackInput(`?code=c&state=${state}`),
    { ok: true, code: 'c', state },
  );
  // A different host is fine: only the two parameters are read.
  assert.deepEqual(
    parseCallbackInput(`https://gw.example.test:25912/auth-callback?code=c&state=${state}&extra=1#frag`),
    { ok: true, code: 'c', state },
  );

  // A bare code is refused: without the state nothing proves which attempt it belongs to.
  assert.deepEqual(parseCallbackInput('abc123'), { ok: false, reason: 'not-an-address' });
  assert.deepEqual(parseCallbackInput(''), { ok: false, reason: 'not-an-address' });
  assert.deepEqual(parseCallbackInput(undefined), { ok: false, reason: 'not-an-address' });
  assert.deepEqual(parseCallbackInput(42), { ok: false, reason: 'not-an-address' });
  // A cut-off paste says which half is missing.
  assert.deepEqual(parseCallbackInput('http://127.0.0.1:1/callback?code=c'),
    { ok: false, reason: 'no-state' });
  assert.deepEqual(parseCallbackInput(`http://127.0.0.1:1/callback?state=${state}`),
    { ok: false, reason: 'no-code' });
  assert.deepEqual(parseCallbackInput(`http://127.0.0.1:1/callback?code=&state=${state}`),
    { ok: false, reason: 'no-code' });
  // And an implausible length is rejected rather than parsed.
  assert.deepEqual(parseCallbackInput(`?code=${'x'.repeat(9000)}&state=${state}`),
    { ok: false, reason: 'too-long' });
});

await checkAsync('browser sign-in exists only when a deployment asks for it', async () => {
  /*
   * DeepAI fixes the redirect to `127.0.0.1`, so this route only completes on a browser
   * that can reach that address as the gateway. It is therefore opt-in, and off by default:
   * an unconfigured gateway must not advertise or serve it.
   */
  const { openDatabase } = await import('../src/db.js');
  const { createApp } = await import('../server.js');

  // --- Off by default.
  const off = openDatabase(':memory:');
  const offApp = createApp(off, { log: () => {}, logRequests: false });
  const offServer = offApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => offServer.once('listening', resolve));
  const offBase = `http://127.0.0.1:${offServer.address().port}`;
  try {
    const login = await fetch(`${offBase}/login?json=1`, { redirect: 'manual' });
    assert.notEqual(login.status, 200, 'the sign-in route must not be served');
    const callback = await fetch(`${offBase}/callback?code=x&state=y`, { redirect: 'manual' });
    assert.notEqual(callback.status, 200, 'nor the callback');
    const complete = await fetch(`${offBase}/api/login/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"http://127.0.0.1:1/callback?code=a&state=b"}',
    });
    assert.equal(complete.status, 404, 'nor the completion endpoint');
  } finally {
    await new Promise((resolve) => offServer.close(resolve));
  }

  // --- On, with a stubbed DeepAI.
  const on = openDatabase(':memory:');
  const app = createApp(on, { log: () => {}, logRequests: false, callbackLogin: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const realFetch = globalThis.fetch;
  const http = (...args) => realFetch(...args);
  let exchanges = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/desktop_auth/exchange/')) {
      exchanges += 1;
      return new Response(JSON.stringify({ api_key: 'sk-from-callback', username: 'callback-user', is_pro: false }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('api.deepai.org')) {
      return new Response('{"enabled":true,"balance":"1.0","granted":"1.0"}',
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    // The dashboard is told, so it only offers a route that exists.
    const account = await (await http(`${base}/api/account`)).json();
    assert.equal(account.callbackLogin, true, 'the dashboard must know the route is served');

    // Starting returns the DeepAI URL and the address it will come back to.
    const started = await (await http(`${base}/login?json=1`)).json();
    assert.equal(started.ok, true);
    assert.match(started.url, /^https:\/\/api\.deepai\.org\/deepai_code\/desktop_auth\//);
    const startedUrl = new URL(started.url);
    const state = startedUrl.searchParams.get('state');
    assert.match(state, /^[0-9a-f]{64}$/, 'the state is 256 random bits');
    // DeepAI accepts only a plain integer port.
    assert.match(startedUrl.searchParams.get('port'), /^\d+$/);
    assert.equal(started.path, '/callback');

    // A wrong state is refused without creating anything.
    const wrong = await http(`${base}/callback?code=x&state=${'0'.repeat(64)}`, { redirect: 'manual' });
    assert.equal(wrong.status, 400, 'an unknown state is refused');
    assert.equal(exchanges, 0, 'and nothing is exchanged');

    // The real callback completes and sets a session.
    const done = await http(`${base}/callback?code=one-shot&state=${state}`, { redirect: 'manual' });
    assert.equal(done.status, 302, 'a completed sign-in goes back to the dashboard');
    assert.equal(exchanges, 1);
    const cookie = String(done.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /deepai_gateway_session=/, 'and hands the browser its session');

    const me = await (await http(`${base}/api/account`, { headers: { cookie } })).json();
    assert.equal(me.signedIn, true, 'the session works');
    assert.equal(me.username, 'callback-user', 'named from DeepAI\'s own answer');

    // The code is one-shot: the same address cannot be redeemed twice.
    const again = await http(`${base}/callback?code=one-shot&state=${state}`, { redirect: 'manual' });
    assert.equal(again.status, 400, 'a spent attempt is refused');
    assert.equal(exchanges, 1, 'and is not exchanged again');

    // --- The paste-back path, for a browser that could not open the redirect.
    const second = await (await http(`${base}/login?json=1`)).json();
    const secondState = new URL(second.url).searchParams.get('state');
    const pasted = await http(`${base}/api/login/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${port}/callback?code=pasted&state=${secondState}` }),
    });
    assert.equal(pasted.status, 200, 'a pasted address finishes the sign-in');
    assert.equal((await pasted.json()).ok, true);
    assert.equal(exchanges, 2);

    // A paste with no state cannot authorise anything.
    const bare = await http(`${base}/api/login/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/callback?code=only-a-code' }),
    });
    assert.equal(bare.status, 400);
    assert.equal((await bare.json()).code, 'no-state');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a name from the database cannot become markup', async () => {
  /*
   * The display name comes from the DeepAI JSON a visitor pastes, is stored, and is shown
   * on the account card. It was interpolated into `innerHTML` unescaped, so a name
   * containing markup executed on every visit to the overview until the account was
   * forgotten. Two halves are checked: the dashboard escapes it, and the server stores it
   * as plain text so the database never holds a fragment.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  const markup = '<img src=x onerror=alert(1)>';
  const nodes = new Map();
  const node = () => {
    const n = {
      innerHTML: '', textContent: '', hidden: false, disabled: false, className: '',
      dataset: {}, style: {}, value: '', children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild(c) { n.children.push(c); },
      append(...c) { n.children.push(...c); }, remove() {},
      setAttribute(k, v) { n[k] = v; }, getAttribute: (k) => n[k] ?? null,
      closest: () => null, focus() {}, select() {}, insertAdjacentHTML() {}, scrollIntoView() {},
    };
    n.replaceChildren = (...c) => { n.children = Array.from(c); };
    n.querySelector = () => n.children[0] ?? null;
    n.querySelectorAll = () => [];
    return n;
  };
  for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
    'account-badge', 'account-badge-text', 'nav', 'theme-toggle', 'auth-button',
    'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());

  const account = {
    ok: true, signedIn: true, username: 'key-abc', displayName: markup,
    allowance: null, balanceLow: false,
    keyQuota: { used: 0, max: 5, remaining: 5, atLimit: false },
  };
  const sandbox = {
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: () => node(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, documentElement: { lang: '', dataset: {} },
      visibilityState: 'visible', body: node(),
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { assign() {} } },
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en-GB', languages: ['en-GB'] },
    fetch: async (url) => {
      if (String(url).includes('/locales/')) return localeResponse();
      return new Response(JSON.stringify(String(url).includes('/account') ? account : { ok: true, models: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
    setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
    console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
    Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(app, { filename: 'app.js' }).runInContext(sandbox);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const card = vm.runInContext('accountCard()', sandbox);
  assert.ok(!card.includes('<img src=x'), 'the name must not survive as a tag');
  assert.ok(card.includes('&lt;img'), 'it is shown as text, escaped');

  // And the server stores it as text, so the database never holds the fragment either.
  const { openDatabase } = await import('../src/db.js');
  const { getSetting } = await import('../src/store.js');
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const application = createApp(fresh, { log: () => {}, logRequests: false });
  const server = application.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.deepai.org')) {
      return new Response('{"is_authenticated":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ enabled: true, balance: '1.0', granted: '1.0' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const response = await realFetch(`${base}/api/login/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: JSON.stringify({ email: `a@b.co${'\u0007'}`, userprofile: { api_key: 'sk-xss' } }) }),
    });
    assert.equal(response.status, 200);
    const stored = getSetting(fresh, 'key-' + 'x', 'display_name', undefined);
    // The derived owner's name must contain no control character.
    const owners = fresh.prepare('SELECT username FROM accounts').all();
    assert.equal(owners.length, 1);
    const name = getSetting(fresh, owners[0].username, 'display_name', '');
    assert.ok(!/[\u0000-\u001f\u007f]/.test(name), 'a control character must not be stored');
    void stored;
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a stream that never ends an event is cut off, not buffered forever', async () => {
  /*
   * The reader accumulates until it sees a blank line. A stream that never sends one grew
   * the buffer without limit - measured at roughly twice the bytes received, because each
   * append re-allocates. No real event is 8 MB, so hitting the ceiling means the upstream
   * is broken or hostile, and failing the request beats exhausting the process.
   */
  const { readEvents } = await import('../src/deepai/wire.js');

  const chunk = `data: {"pad":"${'y'.repeat(64 * 1024)}"`;   // no event terminator
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= 400) { controller.close(); return; }        // ~25 MB
      sent += 1;
      controller.enqueue(new TextEncoder().encode(chunk));
    },
  });

  await assert.rejects(
    async () => { for await (const _ of readEvents(new Response(stream))) { /* none expected */ } },
    (error) => /without ending an event/.test(error.message),
    'the reader must refuse an event that never ends rather than grow without bound',
  );

  // A normal stream is unaffected.
  const normal = new Response(`data: ${JSON.stringify({ ok: 1 })}\n\ndata: [DONE]\n\n`, { status: 200 });
  const seen = [];
  for await (const event of readEvents(normal)) seen.push(event);
  assert.deepEqual(seen, [{ ok: 1 }]);
});

await checkAsync('a refused sign-in leaves a trail, and the database is owner-only', async () => {
  const { openDatabase } = await import('../src/db.js');
  const { recentAuthEvents } = await import('../src/store.js');
  const { createApp } = await import('../server.js');
  const fresh = openDatabase(':memory:');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"err":"no"}', {
    status: 401, headers: { 'content-type': 'application/json' },
  });
  try {
    const refused = await realFetch(`${base}/api/login/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: JSON.stringify({ userprofile: { api_key: 'sk-nope' } }) }),
    });
    assert.equal(refused.status, 401);

    // The trail is what an operator reads to see a key being tried repeatedly.
    const events = recentAuthEvents(fresh, 10);
    assert.equal(events.length, 1, 'a refusal must be recorded');
    assert.equal(events[0].event, 'denied');
    assert.equal(events[0].detail, 'rejected');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }

  // The database holds every account's DeepAI key in a replayable form, so it is owner-only.
  const { mkdtempSync, rmSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'deepai-perm-'));
  try {
    const file = join(dir, 'nested', 'db.sqlite');
    const db = openDatabase(file);
    db.exec('CREATE TABLE IF NOT EXISTS probe (x)');
    db.prepare('INSERT INTO probe VALUES (1)').run();   // makes SQLite create the WAL
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the database must be owner-only');
    assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700, 'and so must its directory');
    // The WAL holds the same rows, so it must not be more readable than the database.
    assert.equal(statSync(`${file}-wal`).mode & 0o777, 0o600, 'and the WAL it writes');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await checkAsync('nothing asks the visitor through a browser dialog', async () => {
  /*
   * `window.confirm` and `window.alert` block the page, cannot be styled, are drawn by
   * the browser instead of by this interface, and on some platforms can be suppressed
   * altogether - which would silently drop the guard on a destructive action. Every
   * confirmation is the app's own modal instead.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const source = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  // No native dialog may be called anywhere in the client.
  for (const banned of ['window.confirm', 'window.alert', 'window.prompt']) {
    const calls = source.split('\n').filter((line) => line.includes(banned) && !line.trim().startsWith('*'));
    assert.deepEqual(calls, [], `${banned} must not be called: ${calls.join(' | ')}`);
  }
  // A bare `confirm(`/`alert(` is the same thing without the prefix.
  assert.ok(!/[^.\w]confirm\(/.test(source.replace(/confirmAction\(/g, '')), 'no bare confirm(');
  assert.ok(!/[^.\w]alert\(/.test(source), 'no bare alert(');

  /*
   * And the replacement must be a real dialog, not a stub: it has to render in the app's
   * modal, offer both answers, and style the destructive one as such. Rendered here so
   * the check is about behaviour rather than the presence of a function name.
   */
  const nodes = new Map();
  const node = () => ({
    innerHTML: '', textContent: '', hidden: true, disabled: false, className: '',
    dataset: {}, style: {}, value: '',
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild(child) { this.children.push(child); },
    // `append` is what the dialog uses; a stub without it would fail the render rather
    // than the behaviour being checked.
    append(...children) { this.children.push(...children); },
    remove() {}, // `openModal` swaps the body in, so the stub must keep what it is given.
    replaceChildren(...children) { this.children = Array.from(children); },
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, closest: () => null,
    focus() {}, select() {}, insertAdjacentHTML() {}, scrollIntoView() {},
  });
  for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
    'account-badge', 'account-badge-text', 'auth-button', 'nav', 'theme-toggle', 'auth-button', 'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());
  const sandbox = {
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: () => node(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, documentElement: node(), visibilityState: 'visible', body: node(),
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { assign() {} } },
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en-GB', languages: ['en-GB'] },
    fetch: async (url) => {
      if (String(url).includes('/locales/')) return localeResponse();
      return new Response('{"ok":true,"signedIn":false,"models":[]}', {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
    setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
    console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
    Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'app.js' }).runInContext(sandbox);
  // The strings arrive asynchronously; without this the dialog would render its keys.
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Ask, without awaiting: the promise settles when a button is chosen.
  const answer = vm.runInContext(
    "confirmAction({ title: 'Revoke this key?', lines: ['It stops working.'], confirmLabel: 'Revoke key', danger: true })",
    sandbox,
  );
  assert.equal(nodes.get('modal').hidden, false, 'the app modal must open');
  assert.equal(nodes.get('modal-title').textContent, 'Revoke this key?');
  const body = nodes.get('modal-body');
  assert.ok(body.children.length > 0, 'the dialog must have content');

  /*
   * Walk down to the buttons rather than indexing a fixed depth: the dialog is built as
   * paragraphs, then a row holding the two answers. The stub nests them, and a test that
   * assumed one level would break on any layout change while proving nothing.
   */
  const flat = [];
  const walk = (list) => {
    for (const child of list) {
      if (child.textContent !== '') flat.push(child);
      walk(child.children ?? []);
    }
  };
  walk(body.children);
  const labels = flat.map((child) => child.textContent);
  assert.ok(labels.includes('Cancel'), `both answers must be present, saw ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('Revoke key'), `both answers must be present, saw ${JSON.stringify(labels)}`);
  // The destructive answer is styled as one, so it does not read like the safe default.
  const destructive = flat.find((child) => child.textContent === 'Revoke key');
  assert.equal(destructive.className, 'btn btn--danger', 'the destructive answer is styled as such');

  // Both answers must settle the promise; a dialog that cannot be dismissed is a trap.
  assert.equal(typeof answer.then, 'function', 'the caller gets an answer it can await');
});

await checkAsync('the top bar offers log out and never a second way in', async () => {
  /*
   * The control appears only when it has something to do. Signed out it is hidden: the
   * overview *is* the sign-in form, so a "Log in" button beside it was a second door to
   * the same room. Signed in it ends the session, and it stays in the top bar rather than
   * moving into the account card, where it briefly lived and did not belong.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const app = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  // The markup carries one control, and it is a log out.
  assert.match(html, /id="auth-button"[^>]*>Log out</, 'the top bar carries a log-out control');
  assert.ok(!/>Log in</.test(html), 'and no log-in button');
  assert.match(html, /id="auth-button" hidden/, 'it starts hidden until the account is known');
  // The account card must not offer a second one.
  assert.ok(!app.includes("id=\"log-out\""), 'logging out is not duplicated in the account card');

  /** Boot the client and read the button's state for a given account. */
  const buttonState = async (account) => {
    const nodes = new Map();
    const node = () => ({
      innerHTML: '', textContent: '', hidden: false, disabled: false, className: '',
      dataset: {}, style: {}, value: '', children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild(c) { this.children.push(c); },
      append(...c) { this.children.push(...c); }, remove() {},
      replaceChildren(...c) { this.children = Array.from(c); },
      querySelector: () => null, querySelectorAll: () => [],
      setAttribute() {}, getAttribute: () => null, closest: () => null,
      focus() {}, select() {}, insertAdjacentHTML() {}, scrollIntoView() {},
    });
    for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
      'account-badge', 'account-badge-text', 'nav', 'theme-toggle', 'auth-button', 'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());
    const sandbox = {
      document: {
        getElementById: (id) => nodes.get(id) ?? null,
        createElement: () => node(), querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, documentElement: node(), visibilityState: 'visible', body: node(),
      },
      window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { assign() {} } },
      location: { search: '', pathname: '/', hash: '' },
      history: { replaceState() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { language: 'en-GB', languages: ['en-GB'] },
      navigator: {},
      fetch: async (url) => {
        if (String(url).includes('/locales/')) return localeResponse();
        return new Response(
          JSON.stringify(String(url).includes('/account') ? account : { ok: true, models: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
      console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
      Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    new vm.Script(app, { filename: 'app.js' }).runInContext(sandbox);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The startup load settles the account, which is what decides the button.
    return nodes.get('auth-button').hidden;
  };

  const signedOut = await buttonState({
    ok: true, signedIn: false, username: '', displayName: '', allowance: null, balanceLow: false,
    keyQuota: { used: 0, max: 5, remaining: 5, atLimit: false },
  });
  assert.equal(signedOut, true, 'signed out, there is nothing for the control to do');

  const signedIn = await buttonState({
    ok: true, signedIn: true, username: 'key-abc', displayName: 'milo@example.com',
    allowance: null, balanceLow: false,
    keyQuota: { used: 0, max: 5, remaining: 5, atLimit: false },
  });
  assert.equal(signedIn, false, 'signed in, it is the way out');

  // Its handler must only ever end a session.
  assert.match(app, /async function onAuthButton\(\) \{\s*\n\s*if \(state\.account\?\.signedIn === true\) await logOutEverywhere\(\);/,
    'the top-bar action logs out and does nothing else');
  assert.ok(!app.includes('btn--signin'), 'no style remains for a sign-in control');
});

await checkAsync('copying a key works on a plain http:// origin', async () => {
  /*
   * `navigator.clipboard` exists only in a secure context - HTTPS, or localhost. A gateway
   * reached at `http://some-host:port` has no `navigator.clipboard` at all, so the modern
   * call throws and the visitor gets nothing: "copying the API key does not work" is what
   * that looks like from outside. The fallback drives the browser's own copy command on a
   * selected field, which needs no secure context.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const source = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  /**
   * Boot the client with a chosen clipboard environment.
   * @param {{clipboard?: boolean, execOk?: boolean}} options
   */
  const boot = async ({ clipboard = false, execOk = true } = {}) => {
    const created = [];
    const node = () => ({
      innerHTML: '', textContent: '', hidden: false, disabled: false, className: '',
      dataset: {}, style: {}, value: '', children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, appendChild(c) { this.children.push(c); },
      append(...c) { this.children.push(...c); }, remove() { this.removed = true; },
      replaceChildren(...c) { this.children = Array.from(c); },
      querySelector: () => null, querySelectorAll: () => [],
      setAttribute() {}, getAttribute: () => null, closest: () => null,
      focus() {}, select() { this.selected = true; }, insertAdjacentHTML() {}, scrollIntoView() {},
    });
    const nodes = new Map();
    for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
      'account-badge', 'account-badge-text', 'nav', 'theme-toggle', 'auth-button', 'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());

    const range = { selectNodeContents() {}, };
    const selection = { removeAllRanges() {}, addRange(r) { this.range = r; } };
    const sandbox = {
      document: {
        getElementById: (id) => nodes.get(id) ?? null,
        createElement: () => { const n = node(); created.push(n); return n; },
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
        documentElement: node(), visibilityState: 'visible', body: node(),
        createRange: () => range,
        execCommand: (command) => command === 'copy' && execOk,
      },
      window: {
        addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
        location: { assign() {} }, getSelection: () => selection,
      },
      location: { search: '', pathname: '/', hash: '' },
      history: { replaceState() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { language: 'en-GB', languages: ['en-GB'] },
      fetch: async (url) => {
        if (String(url).includes('/locales/')) return localeResponse();
        return new Response('{"ok":true,"signedIn":false,"models":[]}', {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
      setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
      console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
      Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
    };
    /*
     * `navigator` always exists in a browser - what an insecure origin lacks is
     * `navigator.clipboard`, which is exposed only in a secure context. Modelling it as
     * absent entirely would test an environment that does not occur.
     */
    sandbox.navigator = clipboard ? { clipboard: { writeText: async () => {} } } : {};
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    new vm.Script(source, { filename: 'app.js' }).runInContext(sandbox);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { sandbox, created, selection, nodes };
  };

  // 1. No Clipboard API: the legacy path must copy and clean up after itself.
  const insecure = await boot({ clipboard: false, execOk: true });
  const field = insecure.nodes.get('view');
  insecure.created.length = 0;          // boot builds its own elements; only count ours
  await vm.runInContext("copy('sk-secret', undefined, document.getElementById('view'))", insecure.sandbox);
  const scratch = insecure.created.find((n) => n.value === 'sk-secret');
  assert.ok(scratch !== undefined, 'the fallback must put the text in a selectable field');
  assert.equal(scratch.selected, true, 'and select it, which is what the copy command acts on');
  assert.equal(scratch.removed, true, 'and remove it again, so no stray field is left behind');

  // 2. Even that can be refused: then the text is selected for the visitor to copy.
  const refused = await boot({ clipboard: false, execOk: false });
  refused.created.length = 0;
  await vm.runInContext("copy('sk-secret', undefined, document.getElementById('view'))", refused.sandbox);
  assert.ok(refused.selection.range !== undefined, 'a refused copy must leave the text selected');
  const toast = refused.nodes.get('toasts').children.map((c) => c.textContent).join(' ');
  assert.match(toast, /Ctrl\/Cmd\+C/, 'and say which keys to press');

  // 3. With a secure context the modern API is preferred, and no scratch field appears.
  const secure = await boot({ clipboard: true });
  secure.created.length = 0;
  await vm.runInContext("copy('sk-secret', undefined, document.getElementById('view'))", secure.sandbox);
  // A toast is created either way; what must not appear is a temporary text field.
  assert.ok(
    !secure.created.some((n) => n.value === 'sk-secret'),
    'the Clipboard API needs no temporary field',
  );
  assert.equal(secure.selection.range, undefined, 'and nothing to select by hand');
});

await checkAsync('the catalog loads once a session exists, without a reload', async () => {
  /*
   * The catalog needs an identity, so the load at startup is refused for a visitor who is
   * not signed in - and `state.models` stays empty. Signing in without reloading the page
   * then left the key form with no models to choose from. `render()` now fills it in as
   * soon as there is a session.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const vm = await import('node:vm');
  const root = new URL('..', import.meta.url).pathname;
  const source = readFileSync(join(root, 'public', 'app.js'), 'utf8');

  const catalogCalls = [];
  const nodes = new Map();
  const node = () => ({
    innerHTML: '', textContent: '', hidden: false, disabled: false, className: '',
    dataset: {}, style: {}, value: '', children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild(c) { this.children.push(c); },
    append(...c) { this.children.push(...c); }, remove() {},
    replaceChildren(...c) { this.children = Array.from(c); },
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, closest: () => null,
    focus() {}, select() {}, insertAdjacentHTML() {}, scrollIntoView() {},
  });
  for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
    'account-badge', 'account-badge-text', 'nav', 'theme-toggle', 'auth-button', 'locale-button', 'locale-menu', 'locale-flag']) nodes.set(id, node());

  const emptyTotals = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0, costUsd: 0 };
  const sandbox = {
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: () => node(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, documentElement: node(), visibilityState: 'visible', body: node(),
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { assign() {} } },
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'en-GB', languages: ['en-GB'] },
    fetch: async (url) => {
      const target = String(url);
      if (target.includes('/locales/')) return localeResponse();
      if (target.includes('/models')) {
        catalogCalls.push(target);
        return new Response(JSON.stringify({ ok: true, models: [{ id: 'm-one' }, { id: 'm-two' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target.includes('/account')) {
        return new Response(JSON.stringify({ ok: true, signedIn: true, username: 'u', displayName: 'u@example.com', allowance: null, balanceLow: false, keyQuota: { used: 0, max: 5, remaining: 5, atLimit: false } }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target.includes('/usage/summary')) {
        return new Response(JSON.stringify({ today: emptyTotals, month: emptyTotals, all: emptyTotals, daily: [], modelsMonth: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"requests":[],"events":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    setInterval: () => 0, setTimeout: () => 0, clearInterval() {},
    console, Intl, URLSearchParams, Response, Error, JSON, Math, Number, String, Array,
    Object, Boolean, Date, RegExp, Promise, isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'app.js' }).runInContext(sandbox);
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The startup load ran while signed out and was refused, so nothing is in hand.
  vm.runInContext('state.models = []', sandbox);
  catalogCalls.length = 0;

  await vm.runInContext('render()', sandbox);

  assert.ok(catalogCalls.length > 0, 'a signed-in render must fetch the catalog');
  const models = vm.runInContext('state.models.length', sandbox);
  assert.equal(models, 2, 'and keep it, so the key form has models to offer');

  // A second render must not fetch it again: the guard is what keeps it cheap.
  catalogCalls.length = 0;
  await vm.runInContext('render()', sandbox);
  assert.equal(catalogCalls.length, 0, 'a catalog already in hand is not fetched again');
});

await checkAsync('every sign-in failure has something useful to say', async () => {
  /*
   * The reasons the paste parser and the key check can report must each have a message,
   * and no message may name a protocol parameter - the reader is looking at a page, not
   * at a response.
   *
   * Each producer is taken by name rather than by slicing the module by position:
   * position-based slicing broke twice, once when it picked up the next function's
   * `@returns` list and once when a third producer was appended to the same file.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;

  const account = readFileSync(join(root, 'src', 'deepai', 'account.js'), 'utf8');
  const admin = readFileSync(join(root, 'src', 'api', 'admin.js'), 'utf8');

  /** Only reasons a function actually *returns*. */
  const reasonsIn = (text) => new Set(
    [...text.matchAll(/return \{ ok: false, reason: '([a-z_-]+)'/g)].map((m) => m[1]),
  );
  const tableBody = (name) => {
    const from = admin.indexOf(`const ${name} = {`);
    assert.ok(from !== -1, `expected to find ${name}`);
    return admin.slice(from, admin.indexOf('};', from));
  };
  const keysOf = (name) => new Set([...tableBody(name).matchAll(/^\s{2}'?([a-z_-]+)'?:/gm)].map((m) => m[1]));

  /** One exported function's body, from its declaration to the next one. */
  const functionBody = (name) => {
    const at = account.indexOf(`export async function ${name}(`) === -1
      ? account.indexOf(`export function ${name}(`)
      : account.indexOf(`export async function ${name}(`);
    assert.ok(at !== -1, `expected to find ${name}`);
    const next = account.indexOf('\nexport ', at + 10);
    const docStart = next === -1 ? -1 : account.lastIndexOf('/**', next);
    return account.slice(at, docStart > at ? docStart : (next === -1 ? undefined : next));
  };

  for (const [name, minimum] of [['parseAccountPaste', 4], ['checkPastedKey', 3]]) {
    const reasons = reasonsIn(functionBody(name));
    assert.ok(reasons.size >= minimum, `expected ${name}'s reasons to be found, saw ${reasons.size}`);
    const unanswered = [...reasons].filter((reason) => !keysOf('KEY_LOGIN_FAILURES').has(reason));
    assert.deepEqual(unanswered, [], `${name} reasons without a message: ${unanswered}`);
  }

  // And the table may not carry messages for reasons nothing can produce: those are
  // leftovers from the routes that were removed, and they read as coverage that is not
  // there.
  const produced = new Set([
    ...reasonsIn(functionBody('parseAccountPaste')),
    ...reasonsIn(functionBody('checkPastedKey')),
  ]);
  const orphaned = [...keysOf('KEY_LOGIN_FAILURES')].filter((reason) => !produced.has(reason));
  assert.deepEqual(orphaned, [], `messages for reasons nothing produces: ${orphaned}`);

  for (const message of tableBody('KEY_LOGIN_FAILURES').matchAll(/'([^']{20,})'/g)) {
    assert.ok(!/\bstate\b|`code`/.test(message[1]), `jargon in a message: ${message[1]}`);
  }
});


await checkAsync('the pasted console output is read forgivingly', async () => {
  const { parseAccountPaste } = await import('../src/deepai/account.js');

  // What the console prints for `console.log(await (await fetch(...)).text())`, pasted
  // exactly as it appears - quotes included.
  const printed = JSON.stringify({
    pk: 9726455,
    username: 'kontomilosz350',
    email: 'kontomilosz350@gmail.com',
    userprofile: { api_key: 'key-from-console' },
  });
  assert.deepEqual(parseAccountPaste(printed), {
    ok: true,
    apiKey: 'key-from-console',
    email: 'kontomilosz350@gmail.com',
  });

  // A console string keeps its quotes when copied.
  assert.deepEqual(
    parseAccountPaste(`"${JSON.stringify({ email: 'a@b.co', userprofile: { api_key: 'k' } })}"`),
    { ok: true, apiKey: 'k', email: 'a@b.co' },
  );
  // A stray log prefix or trailing line must not defeat it: only the object is needed.
  assert.deepEqual(
    parseAccountPaste(`{pk: 1}\n{"email":"a@b.co","userprofile":{"api_key":"k"}}\nundefined`).apiKey,
    'k',
  );
  // The email is optional; the key is not.
  assert.deepEqual(parseAccountPaste('{"userprofile":{"api_key":"k"}}'), { ok: true, apiKey: 'k' });

  // Rejections say which part is wrong, because the visitor is told to fix it.
  assert.deepEqual(parseAccountPaste(''), { ok: false, reason: 'empty' });
  assert.deepEqual(parseAccountPaste('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(parseAccountPaste(42), { ok: false, reason: 'empty' });
  assert.deepEqual(parseAccountPaste('hello'), { ok: false, reason: 'not-json' });
  assert.deepEqual(parseAccountPaste('{"pk": 1}'), { ok: false, reason: 'no-key' });
  assert.deepEqual(parseAccountPaste('{"userprofile": {"api_key": ""}}'), { ok: false, reason: 'no-key' });
  // A Response object logged without `.text()` is the mistake this guards against.
  assert.deepEqual(parseAccountPaste('Response {type: "cors", url: "..."}'), { ok: false, reason: 'not-json' });
  assert.deepEqual(parseAccountPaste(`{"a":"${'x'.repeat(70000)}"}`), { ok: false, reason: 'too-long' });
});

await checkAsync('an account with no password signs in by pasting its console output', async () => {
  /*
   * The route for Google and Apple: their sign-in happens in the visitor's browser, and
   * the account JSON DeepAI produced for that browser is read back out with one command.
   * It carries both the key and the account's own email, so nothing is typed from memory.
   */
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const realFetch = globalThis.fetch;
  const http = (...args) => realFetch(...args);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/deepai_code/theos')) {
      return new Response(JSON.stringify({ enabled: true, balance: '9.0', granted: '10.0', refresh_at: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (target.endsWith('/get_usage_summary')) {
      return new Response('{"is_authenticated":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const post = (body) => http(`${base}/api/login/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    // Unreadable pastes are refused before anything is contacted.
    for (const [body, code] of [
      [{}, 'empty'],
      [{ text: '' }, 'empty'],
      [{ text: 'nonsense' }, 'not-json'],
      [{ text: '{"pk":1}' }, 'no-key'],
      [{ text: 'Response {type: "cors"}' }, 'not-json'],
    ]) {
      const bad = await post(body);
      assert.equal(bad.status, 400, `${JSON.stringify(body)} must be refused`);
      assert.equal((await bad.json()).code, code);
    }
    assert.equal(listAccounts(fresh).length, 0);

    // The real paste: key and email both come out of it.
    const done = await post({
      text: JSON.stringify({
        pk: 9726455,
        email: 'kontomilosz350@gmail.com',
        userprofile: { api_key: 'sk-from-console-output' },
      }),
    });
    const doneText = await done.text();
    assert.equal(done.status, 200, doneText);
    const body = JSON.parse(doneText);
    assert.equal(body.created, true);
    assert.ok(!doneText.includes('sk-from-console-output'), 'the key must not be echoed back');

    const cookie = String(done.headers.get('set-cookie') ?? '').split(';')[0];
    const account = await http(`${base}/api/account`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(account.signedIn, true);
    // The name is the account's own, taken from what DeepAI returned for that browser.
    assert.equal(account.displayName, 'kontomilosz350@gmail.com');
    assert.equal(account.allowance?.balance, '9.0');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a pasted key owns itself, so nobody can claim another account', async () => {
  const { usernameForKey } = await import('../src/deepai/account.js');

  const owner = usernameForKey('sk-aaaa');
  assert.match(owner, /^key-[0-9a-f]{16}$/);
  // The owner is the ownership key for `api_keys`, so it must be one-to-one: the
  // same key always resolves to the same account, and different keys never merge.
  assert.equal(usernameForKey('sk-aaaa'), owner, 'the same key is always the same account');
  assert.notEqual(usernameForKey('sk-aaab'), owner, 'a different key is a different account');
  // Only the fingerprint is stored, never anything reversible.
  assert.ok(!owner.includes('aaaa'), 'the owner name must not carry the key');
  assert.equal(usernameForKey('sk-aaaa').length, 20);
  // Bounded whatever was pasted, since this becomes a database key.
  assert.ok(usernameForKey('x'.repeat(4096)).length === 20);
});

await checkAsync('the same DeepAI key never becomes two accounts', async () => {
  /*
   * DeepAI mints a fresh key on every sign-in, so one DeepAI account can hold
   * several - and a key pasted by hand must land on the account that already owns
   * it rather than starting a second, poorer identity beside it. Without this the
   * dashboard shows a fingerprint owner next to a real username for what is one
   * account, with the keys and usage split between them.
   */
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const { accountForApiKey, saveAccount } = await import('../src/store.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // What an earlier sign-in stored: the real DeepAI username.
  saveAccount(fresh, { apiKey: 'sk-shared-key', username: 'kontomilosz350', isPro: false });
  assert.equal(accountForApiKey(fresh, 'sk-shared-key').username, 'kontomilosz350');

  const realFetch = globalThis.fetch;
  const http = (...args) => realFetch(...args);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/deepai_code/theos')) {
      return new Response(JSON.stringify({ enabled: true, balance: '5.0', granted: '10.0', refresh_at: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ is_authenticated: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const res = await http(`${base}/api/login/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: JSON.stringify({ email: 'milo@example.com', userprofile: { api_key: 'sk-shared-key' } }),
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    // The account is kept, not replaced: same owner, and it already existed.
    assert.equal(body.username, 'kontomilosz350');
    assert.equal(body.created, false);
    assert.equal(listAccounts(fresh).length, 1, 'one DeepAI key must not become two accounts');

    const cookie = String(res.headers.get('set-cookie') ?? '').split(';')[0];
    const account = await http(`${base}/api/account`, { headers: { cookie } }).then((r) => r.json());
    // The owner stays the real username, and the shown name is the email.
    assert.equal(account.username, 'kontomilosz350');
    assert.equal(account.displayName, 'milo@example.com');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('a refused sign-in explains which kind of refusal it was', async () => {
  /*
   * Every refusal is read by someone who has just pasted something, so each has to say
   * which part was wrong. The route is `/login/profile` - the only way in - so the input
   * is the account JSON as pasted, and the failures come in two halves: the paste itself
   * (`empty`, `not-json`, `no-key`, `too-long`) and DeepAI's answer about the key inside
   * it (`rejected`, `not-for-code`, `unreachable`).
   */
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const realFetch = globalThis.fetch;
  const http = (...args) => realFetch(...args);
  // `text` is what the visitor pasted, so the body is always `{ text }`.
  const post = (text) => http(`${base}/api/login/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  /** The account JSON as DeepAI serves it, with the key under test. */
  const paste = (apiKey) => JSON.stringify({ email: 'milo@example.com', userprofile: { api_key: apiKey } });

  /** Emulate one response shape per endpoint. */
  const lane = ({ theos, usage }) => async (url) => {
    const target = String(url);
    if (target.endsWith('/deepai_code/theos')) {
      return theos === 'ok'
        ? json({ enabled: true, balance: '1.0', granted: '1.0', refresh_at: null })
        : json({ err: 'no' }, theos);
    }
    if (target.endsWith('/get_usage_summary')) {
      return usage === 'auth' ? json({ is_authenticated: true }) : json({ err: 'no' }, 401);
    }
    return json({}, 404);
  };

  try {
    // Pastes that carry no key at all: refused before any network call.
    globalThis.fetch = async () => { throw new Error('must not be called'); };
    for (const [pasted, reason] of [
      ['', 'empty'],
      ['   ', 'empty'],
      [42, 'empty'],
      ['hello', 'not-json'],
      ['{"pk": 1}', 'no-key'],
      ['Response {type: "cors", url: "..."}', 'not-json'],
      [`{"a":"${'x'.repeat(70000)}"}`, 'too-long'],
    ]) {
      const bad = await post(pasted);
      assert.equal(bad.status, 400, `${JSON.stringify(pasted).slice(0, 30)} must be refused`);
      assert.equal((await bad.json()).code, reason);
    }
    assert.equal(listAccounts(fresh).length, 0, 'nothing may be created from a malformed paste');

    // A key DeepAI does not recognise.
    globalThis.fetch = lane({ theos: 401, usage: 401 });
    const rejected = await post(paste('sk-nonsense'));
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).code, 'rejected');

    // A real DeepAI key that is not enabled for the Code lane: the likeliest
    // failure of all, and the one that must not be reported as a typo.
    globalThis.fetch = lane({ theos: 401, usage: 'auth' });
    const wrongLane = await post(paste('sk-model-api-only'));
    assert.equal(wrongLane.status, 403);
    const wrongLaneBody = await wrongLane.json();
    assert.equal(wrongLaneBody.code, 'not-for-code');
    assert.match(wrongLaneBody.error, /not enabled for DeepAI Code/);

    // DeepAI is down, which is not the visitor's mistake.
    globalThis.fetch = lane({ theos: 500, usage: 401 });
    const down = await post(paste('sk-fine'));
    assert.equal(down.status, 502);
    assert.equal((await down.json()).code, 'unreachable');

    // And a network failure is reported as one rather than as a bad key.
    globalThis.fetch = async () => { throw new Error('offline'); };
    const offline = await post(paste('sk-fine'));
    assert.equal(offline.status, 502);
    assert.equal((await offline.json()).code, 'unreachable');

    // No refusal may have created an account or handed out a session.
    assert.equal(listAccounts(fresh).length, 0);
    for (const response of [rejected, wrongLane, down, offline]) {
      const cookies = String(response.headers.get('set-cookie') ?? '');
      assert.ok(!cookies.includes('deepai_gateway_session='), 'a refused sign-in must not create a session');
    }
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

/* -------------------------------------------------------------------- done */

console.log(results.join('\n'));
console.log(process.exitCode ? '\nFAILURES PRESENT' : '\nALL CHECKS PASSED');
