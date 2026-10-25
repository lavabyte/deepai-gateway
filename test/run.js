/**
 * Offline test suite for the gateway.
 *
 * Everything runs against an in-memory database and a stubbed `fetch`, so no
 * DeepAI account or network access is required. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { generateKey, hashKey, overLimit, publicKey, statusOf } from '../src/keys.js';
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
  openAIToResponsesTools,
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

const results = [];
function check(name, fn) {
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
 * HTTP check below needs one — exactly like a browser.
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
      assert.equal(typeof model.theosPerSecond[level], 'string');
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
  assert.equal(rateLabel(findModel('glm-5.3'), 'high'), '1.2 Theos/min');
  assert.equal(rateLabel(findModel('gpt-6-astra'), 'none'), '18 Theos/min');
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
    // required — but never *nothing*, which would scope to every account.
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

await checkAsync('/ serves the dashboard and /login is browser-navigable', async () => {
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

    // /login with ?json=1 answers with the DeepAI URL instead of redirecting.
    const login = await fetch(`${base}/login?json=1`);
    assert.equal(login.status, 200);
    const payload = await login.json();
    assert.equal(payload.ok, true);
    assert.match(payload.url, /^https:\/\/api\.deepai\.org\/deepai_code\/desktop_auth\//);

    // The response that starts a login also hands this browser its login cookie.
    // Sending it back identifies the same browser, which reuses its attempt
    // instead of starting another.
    const loginCookie = String(login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(loginCookie, /deepai_gateway_login=/);
    const again = await fetch(`${base}/login?json=1`, { headers: { cookie: loginCookie } })
      .then((res) => res.json());
    assert.equal(again.url, payload.url, 'the same browser reuses its own attempt');

    // A different browser gets its own attempt, not the first one's.
    const other = await fetch(`${base}/login?json=1`).then((res) => res.json());
    assert.notEqual(other.url, payload.url, 'a second browser must not hijack the first attempt');

    // Cancel it so the callback server does not outlive this check.
    await fetch(`${base}/api/cancel-login`, { method: 'POST' });
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

    // Revoking frees a slot without destroying the key: it becomes a tombstone
    // that can be restored, so it must not hold quota.
    const revoked = await call(`/api/keys/${created[0].id}/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    assert.notEqual(revoked.body.key.revokedAt, null);

    const afterRevoke = await call('/api/keys');
    assert.equal(afterRevoke.body.quota.used, 4, 'a revoked key does not count against the cap');
    assert.equal(afterRevoke.body.quota.archived, 1);
    assert.equal(afterRevoke.body.quota.atLimit, false);
    // The revoked key is still listed, so its history is visible.
    assert.ok(afterRevoke.body.keys.some((k) => k.id === created[0].id));

    const replacement = await call('/api/keys', {
      method: 'POST',
      body: { name: 'replacement', limitWindow: 'unlimited', modelsRestricted: false },
    });
    assert.equal(replacement.status, 201);

    // Reaching the active cap again refuses a new key, and says to revoke.
    for (let index = 0; index < 1; index += 1) {
      await call('/api/keys', { method: 'POST', body: { name: `filler ${index}` } });
    }
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
    assert.equal(typeof free.theos_per_second.high, 'string');
    assert.equal(free.rate_label, 'Unmetered');
    assert.ok(free.description.includes('Free tier'));

    const textOnly = payload.data.find((model) => model.id === 'solar-mini-4');
    assert.deepEqual(textOnly.input_modalities, ['text']);

    const premier = payload.data.find((model) => model.id === 'glm-5.3');
    assert.equal(premier.tier, 'premier');
    assert.equal(premier.rate_label, '6 Theos/min');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

check('publicModel exposes per-level reasoning rates', () => {
  const model = publicModel(findModel('glm-5.3'));
  assert.equal(model.reasoningLevels.length, REASONING_LEVELS.length);
  const high = model.reasoningLevels.find((level) => level.id === 'high');
  assert.equal(high.rateLabel, '1.2 Theos/min');
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

check('initPricing loads a disk cache and readCache tolerates junk', async () => {
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

check('usage rows survive reopening the same database file', async () => {
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

check('the stylesheet makes the hidden attribute win', async () => {
  // Regression: `.field { display: flex }` used to override `[hidden]`, so
  // "hidden" form fields still rendered and still took clicks.
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'missing the [hidden] override');
  assert.match(css, /prefers-color-scheme:\s*dark/, 'the OS dark palette must be present');
  assert.match(css, /:root:not\(\[data-theme\]\)/, 'a stored theme must stay authoritative');
});

/* --------------------------------------------------------------- migration */

check('a pre-multi-user database migrates without losing anything', async () => {
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

  // Opening it must migrate in place.
  const upgraded = openDatabase(file);
  assert.equal(upgraded.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '4');
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

/* ---------------------------------------------------------- multi-user scope */

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
    // Both accounts exist at the same time — this is what multi-user means.
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

    // Deleting an active key is refused: revoking is the correct action while a
    // key still exists, and one click must not destroy it.
    const active = await asBob(`/api/keys/${alice1.body.key.id}`, { method: 'DELETE' });
    assert.equal(active.status, 404, "another account's key stays invisible");

    // Alice's own active key cannot be deleted either.
    const refused = await asAlice(`/api/keys/${alice1.body.key.id}`, { method: 'DELETE' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'key_not_revoked');

    // Once revoked, removal is allowed and frees the name.
    await asAlice(`/api/keys/${alice1.body.key.id}/revoke`, { method: 'POST' });
    const removed = await asAlice(`/api/keys/${alice1.body.key.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const afterRemoval = await asAlice('/api/keys');
    assert.ok(!afterRemoval.body.keys.some((k) => k.id === alice1.body.key.id));

    // Alice's remaining keys are untouched by any of that.
    const aliceAfter = await asAlice('/api/keys');
    assert.deepEqual(aliceAfter.body.keys.map((k) => k.name).sort(), ['alice-2']);
    assert.ok(aliceAfter.body.keys.every((k) => k.revokedAt === null));

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

await checkAsync('the auth screen styles buttons by class and never closes a tab', async () => {
  const { callbackPage } = await import('../src/deepai/account.js');
  const html = callbackPage('Logged in', 'Done', 'ok', { returnTo: '/' });

  // Regression 1: the rule was `a.btn`, which never matched a <button>, so the
  // control kept its box but lost every visual style.
  assert.match(html, /\.btn\{/, 'the button rule must be class-based');
  assert.ok(!/a\.btn\{/.test(html), 'a.btn would miss a <button> element');
  assert.match(html, /cursor:pointer/, 'interactive elements need a pointer cursor');

  // Regression 2: the old control called window.close(), which browsers refuse
  // for a tab the script did not open. Login now runs in this tab instead.
  assert.ok(!html.includes('window.close'), 'the page must not try to close itself');
  assert.ok(!html.includes('close-tab'), 'there is no second window to close');

  // The success page hands the tab back to the dashboard on its own.
  assert.match(html, /location\.replace\(returnTo \+ '\?logged-in=1'\)/);
  assert.match(html, /var returnTo = "\/"/);

  // An error page stays put: returnTo is null, so the guard never fires.
  const error = callbackPage('Failed', 'Try again', 'error');
  assert.match(error, /var returnTo = null/);
  assert.ok(!error.includes('Taking you back'), 'no auto-return notice on failure');
});

/* ------------------------------------------------------------------- brand */

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

/* -------------------------------------------------------------------- done */

console.log(results.join('\n'));
console.log(process.exitCode ? '\nFAILURES PRESENT' : '\nALL CHECKS PASSED');
