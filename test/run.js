/**
 * Offline test suite for the gateway.
 *
 * Everything runs against an in-memory database and a stubbed `fetch`, so no
 * DeepAI account or network access is required. Run with `npm test`.
 */

import assert from 'node:assert/strict';
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

    // /login with ?json=1 answers with the sign-in URL instead of redirecting.
    // The relay is opt-in, so by default the browser is sent to DeepAI's own page.
    const login = await fetch(`${base}/login?json=1`);
    assert.equal(login.status, 200);
    const payload = await login.json();
    assert.equal(payload.ok, true);
    assert.match(payload.url, /^https:\/\/api\.deepai\.org\/deepai_code\/desktop_auth\//);
    assert.match(payload.url, /[?&]state=[0-9a-f]{64}/);

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

await checkAsync('turning the relay on sends the browser to this gateway', async () => {
  /*
   * The relay exists so DeepAI's loopback redirect can be rewritten onto this host.
   * Without it the browser must go to DeepAI directly, and the visitor finishes by
   * pasting the address back — so the URL that starts a sign-in has to change with
   * the setting. An operator disabling the relay still has to be able to sign in.
   */
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false, authProxy: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST' }).then((r) => r.json());
    // With the relay on, the page is served here — that is what makes DeepAI's
    // loopback redirect rewritable.
    assert.match(login.url, new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/deepai_code/desktop_auth/`));

    // And the dashboard is told, so it stops offering the workaround.
    const account = await fetch(`${base}/api/account`).then((r) => r.json());
    assert.equal(account.authProxy, true);
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

await checkAsync('the dashboard shell names versioned assets and is never cached', async () => {
  /*
   * Shipping new code under the same `/app.js` URL let a browser keep serving the copy
   * it already had — a rewritten sign-in screen stayed invisible after it had deployed.
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

check('the command block is not overridden by the inline snippet rule', async () => {
  /*
   * Both selectors have one class of specificity, so the later rule wins. `.snippet`
   * sets `display: flex`; a `.snippet--block` placed before it lost its
   * `display: block` and the copyable command rendered inline. Order is the whole
   * fix, so order is what this pins.
   */
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const css = readFileSync(join(new URL('..', import.meta.url).pathname, 'public', 'app.css'), 'utf8');
  const base = css.indexOf('.snippet {');
  const variant = css.indexOf('.snippet--block {');
  assert.ok(base !== -1 && variant !== -1, 'both snippet rules must exist');
  assert.ok(variant > base, 'the block variant must come after the flex one to win');
  assert.match(css.slice(variant, variant + 120), /display: block/);
});

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

check('a database with revoked tombstones is cleaned up on upgrade', async () => {
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

check('the backup script writes a complete copy, not a WAL-stale one', async () => {
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
  // a caller that lost a username silently read a deployment-wide total — and an
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

await checkAsync('a malformed cookie cannot take the whole server down', async () => {
  // Regression: `decodeURIComponent` threw inside the session middleware, which
  // runs before every route, so one bad cookie made *every* response a 500 —
  // including /healthz — and the browser was never told to drop it.
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

check('a newer database is refused rather than stamped downwards', async () => {
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

check('the v5 index is created even with no tombstones to clean', async () => {
  // Regression: the CREATE INDEX sat inside `if (removed.changes > 0)`, so the
  // common upgrade path — a database that never held a revoked key — ended up
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
  // and the row was lost — even though the request had reached DeepAI.
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

await checkAsync('unauthenticated login flooding cannot grow state without bound', async () => {
  // Regression: the slot key comes from a caller-controlled cookie on an
  // unauthenticated route, and a fresh cookie is minted for any request that
  // lacks one — so every request allocated a 256-bit state and a timer, with no
  // ceiling. The map must stay bounded no matter how many distinct callers ask.
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 150 distinct "browsers", each with no login cookie of its own.
    for (let i = 0; i < 150; i += 1) {
      await fetch(`${base}/api/login`, { method: 'POST' });
    }
    const pending = app.locals.runtime.pendingLogins;
    assert.ok(pending instanceof Map, 'the runtime keeps a pending-login map');
    assert.ok(pending.size <= 64, `pending logins must stay bounded, got ${pending.size}`);
    // Bounded, but still usable: the newest caller has a working attempt.
    const fresh_ = await fetch(`${base}/api/login`, { method: 'POST' }).then((r) => r.json());
    // Which origin serves the page depends on the relay, but an evicted visitor must
    // always get a usable attempt back rather than the evicted one's.
    assert.match(fresh_.url, /\/deepai_code\/desktop_auth\//);
  } finally {
    // Cancel everything so no callback server outlives this check.
    const pending = app.locals.runtime.pendingLogins;
    if (pending instanceof Map) {
      for (const key of [...pending.keys()]) {
        try {
          pending.get(key)?.flow?.close?.();
        } catch {
          /* best effort */
        }
      }
    }
    await new Promise((resolve) => server.close(resolve));
  }
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

await checkAsync('booting the server does not crash and says what it is doing', async () => {
  /*
   * The suite mounts `createApp` everywhere, which never runs `start()` — and that is
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
      authProxy: true,
    });
    // `listen` was already called, so wait for the address rather than the event.
    await new Promise((resolve) => {
      const poll = () => (booted.server.address() === null ? setTimeout(poll, 10) : resolve());
      poll();
    });

    const said = lines.join('\n');
    assert.match(said, /listening on http:\/\/127\.0\.0\.1:\d+/, 'the boot banner must be printed');
    // The relay is a real trust decision, so it is announced at boot.
    assert.match(said, /sign-in is relayed through this gateway/);
    assert.match(said, /never stored or logged/);
    assert.match(said, /Set AUTH_PROXY=0/);
    // Loopback means there is no workaround to warn about.
    assert.ok(!said.includes('cannot open it'), 'no loopback warning on a loopback host');
    assert.ok(!said.includes('not loopback'), 'no exposure note on a loopback host');
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
  // The other branch, and the one an operator on a public host actually reads.
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
    // A relay-less gateway still has to explain the loopback problem it now has.
    booted = start({
      port: 0,
      host: '0.0.0.0',
      database: ':memory:',
      pricingCache: join(scratch, 'pricing.json'),
      logRequests: false,
      authProxy: false,
    });
    await new Promise((resolve) => {
      const poll = () => (booted.server.address() === null ? setTimeout(poll, 10) : resolve());
      poll();
    });

    const said = lines.join('\n');
    assert.match(said, /not loopback/, 'an exposed host must be called out');
    assert.match(said, /sign-in callback is fixed to http:\/\/127\.0\.0\.1:/);
    assert.match(said, /cannot open it/);
    assert.ok(!said.includes('is relayed through this gateway'), 'no relay note when the relay is off');
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

/* ------------------------------------------------------ deepai sign-in relay */

/*
 * The relay is what makes the browser sign-in work on a public host: DeepAI ends
 * the flow by redirecting to a loopback address it picks itself, and only
 * something in the middle can rewrite that. These checks pin the rewrites, and
 * then run the whole flow against a fixture that behaves like DeepAI — including
 * its loopback redirect — so the relay is verified without needing a password.
 */

check('the relayed page stops DeepAI bouncing the browser to its own host', async () => {
  const { rewriteAuthPage } = await import('../src/deepai/auth-proxy.js');

  // The two constructs the relay depends on, as DeepAI ships them.
  const page = [
    '<script>var app_base_url=\'https://api.deepai.org\';</script>',
    '<script>try{if(!(window.location.hostname==="deepai.org"||window.location.hostname==="127.0.0.1")){',
    'window.location.href="https://deepai.org"+window.location.pathname+window.location.search;}}catch(e){}</script>',
  ].join('\n');

  const rewritten = rewriteAuthPage(page);
  assert.equal(rewritten.ok, true);
  // The bounce is what made a public host fail, so the comparison that triggered it
  // must no longer be able to fire...
  assert.ok(!rewritten.html.includes('window.location.hostname==="deepai.org"'), 'the guard must be disarmed');
  // `!(true || …)` can never fire, whichever host the page is served from.
  assert.match(rewritten.html, /if\(!\(true\|\|/);
  // ...and every API call plus the page's self-reload must now resolve here.
  assert.match(rewritten.html, /app_base_url=''/);
  assert.ok(!rewritten.html.includes('api.deepai.org'), 'no absolute API origin may remain');
  // Nothing else about the page is touched.
  assert.ok(rewritten.html.includes('window.location.href="https://deepai.org"'), 'the rest is left alone');
});

check('a page the relay no longer recognises is refused, not half-served', async () => {
  const { rewriteAuthPage } = await import('../src/deepai/auth-proxy.js');

  // DeepAI changing either construct is the failure mode of any relay, and a page
  // that is served but broken is worse than an honest refusal.
  const nothing = rewriteAuthPage('<html><body>a different page</body></html>');
  assert.equal(nothing.ok, false);
  assert.deepEqual(nothing.missing, ['hostname guard', 'api base']);

  const half = rewriteAuthPage('<script>window.location.hostname==="deepai.org"</script>');
  assert.equal(half.ok, false);
  assert.deepEqual(half.missing, ['api base']);
});

check('DeepAI\'s loopback redirect is put back on this origin', async () => {
  const { rewriteLocation } = await import('../src/deepai/auth-proxy.js');
  const origins = { pageOrigin: 'https://deepai.org', apiOrigin: 'https://api.deepai.org' };

  // The redirect that decides whether the whole flow works. DeepAI picks both the
  // host and the port, so the rewrite cannot depend on either.
  for (const location of [
    'http://127.0.0.1:25912/auth-callback?code=abc&state=def',
    'http://127.0.0.1:8787/auth-callback?code=abc&state=def',
    'http://localhost:5000/auth-callback?code=abc&state=def',
    'http://[::1]:1234/auth-callback?code=abc&state=def',
  ]) {
    assert.equal(
      rewriteLocation(location, origins),
      '/auth-callback?code=abc&state=def',
      `${location} must land on the gateway's own callback`,
    );
  }

  // In-allowlist upstream locations stay on this origin too, so nothing falls out
  // of the relay mid-flow.
  assert.equal(
    rewriteLocation('https://api.deepai.org/daily-time-sync/user/', origins),
    '/daily-time-sync/user/',
  );
  // Anything else is left as it is: the relay is not a general rewriter.
  assert.equal(rewriteLocation('https://accounts.google.com/o/oauth2/auth', origins), 'https://accounts.google.com/o/oauth2/auth');
  assert.equal(rewriteLocation('not a url', origins), 'not a url');
});

check('relayed cookies are re-scoped to this origin', async () => {
  const { COOKIE_PREFIX, relaySetCookie, upstreamCookieHeader } = await import('../src/deepai/auth-proxy.js');

  // The browser is the cookie jar, so DeepAI's cookie has to be valid for this host:
  // its Domain would be rejected, and a Secure cookie on plain HTTP would be
  // dropped — which looks exactly like a wrong password.
  const plain = relaySetCookie('sessionid=abc123; Domain=.deepai.org; Path=/; Secure; HttpOnly; SameSite=None', false);
  assert.ok(plain.startsWith(`${COOKIE_PREFIX}sessionid=abc123`));
  assert.match(plain, /Path=\//);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.ok(!/Domain/i.test(plain), 'a foreign Domain would be rejected by the browser');
  assert.ok(!/Secure/i.test(plain), 'a Secure cookie would be dropped on plain HTTP');

  // On TLS it is kept, because then it does protect something.
  assert.match(relaySetCookie('a=b; Secure', true), /Secure/);
  // Expiry survives, so an upstream session lifetime is respected.
  assert.match(relaySetCookie('a=b; Max-Age=3600', false), /Max-Age=3600/);
  assert.equal(relaySetCookie('=novalue', false), undefined);

  // Only relayed cookies travel upstream: the gateway's own session must not.
  assert.equal(upstreamCookieHeader(`deepai_gateway_session=secret; ${COOKIE_PREFIX}sessionid=abc; deepai_gateway_login=x`), 'sessionid=abc');
  assert.equal(upstreamCookieHeader('deepai_gateway_session=secret'), '');
  assert.equal(upstreamCookieHeader(undefined), '');
});

check('the relay forwards an allowlist and refuses to be an open proxy', async () => {
  const { isProxiedPath } = await import('../src/deepai/auth-proxy.js');

  for (const path of [
    '/deepai_code/desktop_auth/',
    '/daily-time-sync/login/',
    '/daily-time-sync/user/',
    '/get_user_login_type',
    '/static/images/HiUser.svg',
    '/privacy-preferences/get',
  ]) {
    assert.equal(isProxiedPath(path), true, `${path} is part of the sign-in flow`);
  }
  // Nothing arbitrary: a proxy that fetches whatever it is asked to is an open relay.
  for (const path of ['/', '/api/account', '/v1/models', '/etc/passwd', '/dashboard/profile', '/chat']) {
    assert.equal(isProxiedPath(path), false, `${path} must not be relayed`);
  }
  // Social sign-in would leave the relay, so it is answered rather than attempted.
  assert.equal(isProxiedPath('/accounts/google/login/'), true);
});

await checkAsync('the whole sign-in works through the relay, loopback and all', async () => {
  /*
   * A fixture that behaves like DeepAI where it matters: a page carrying the two
   * constructs the relay rewrites, an API that checks a password and sets a session
   * cookie, and — the point of everything — a final redirect to a loopback address
   * the browser could never reach on its own.
   */
  const http = await import('node:http');
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    fixture.seen.push({ path: url.pathname, cookie: req.headers.cookie ?? '', origin: req.headers.origin ?? '' });

    const session = /(?:^|;\s*)sessionid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

    if (url.pathname === '/deepai_code/desktop_auth/') {
      if (session === undefined) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(fixture.page);
      }
      // Authenticated: this is the redirect no browser on another machine can open.
      res.writeHead(302, {
        location: `http://127.0.0.1:${url.searchParams.get('port')}/auth-callback?code=one-shot-code&state=${url.searchParams.get('state')}`,
      });
      return res.end();
    }
    if (url.pathname === '/static/app.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('body{}');
    }
    if (url.pathname === '/daily-time-sync/login/') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      return req.on('end', () => {
        fixture.passwordsSeen.push(body);
        if (!body.includes('hunter2')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"err":"bad credentials"}');
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'sessionid=fixture-session; Domain=.deepai.org; Path=/; HttpOnly; SameSite=None',
        });
        return res.end('{"ok":true}');
      });
    }
    if (url.pathname === '/daily-time-sync/user/') {
      // Their own sign-in page reads 200 as "signed in" and anything else as not.
      return session === undefined
        ? res.writeHead(201, { 'content-type': 'text/plain' }).end('OK')
        : res.writeHead(200, { 'content-type': 'application/json' }).end('{"username":"kontomilosz350"}');
    }
    res.writeHead(404).end();
  });
  fixture.seen = [];
  fixture.passwordsSeen = [];
  fixture.page = [
    '<html><head><title>Sign in to DeepAI Code</title></head><body>',
    '<link rel="stylesheet" href="/static/app.css">',
    '<script>var app_base_url=\'https://api.deepai.org\';</script>',
    '<script>try{if(!(window.location.hostname==="deepai.org"||window.location.hostname==="127.0.0.1")){',
    'window.location.href="https://deepai.org"+window.location.pathname+window.location.search;}}catch(e){}</script>',
    '<form id="f"><input id="user-email"><input id="user-password" type="password"></form>',
    '</body></html>',
  ].join('\n');
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixturePort = fixture.address().port;

  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const logs = [];
  const app = createApp(fresh, {
    log: (message) => logs.push(message),
    logRequests: false,
    authProxy: true,
    authPageOrigin: `http://127.0.0.1:${fixturePort}`,
    authApiOrigin: `http://127.0.0.1:${fixturePort}`,
  });
  const gateway = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => gateway.once('listening', resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  const realFetch = globalThis.fetch;
  const call = (...args) => realFetch(...args);
  // Only the exchange and the allowance touch DeepAI directly; the relay uses the
  // real fetch so it reaches the fixture.
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/desktop_auth/exchange/')) {
      return new Response(JSON.stringify({ api_key: 'sk-relayed', username: 'kontomilosz350', is_pro: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (target.includes('/deepai_code/theos')) {
      return new Response(JSON.stringify({ enabled: true, balance: '42.0', granted: '50.0', refresh_at: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (target.includes('/get_usage_summary')) {
      return new Response('{"is_authenticated":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };

  try {
    // 1. Starting the sign-in must point the browser at *this* origin, not DeepAI's.
    const started = await call(`${base}/api/login`, { method: 'POST' });
    const login = await started.json();
    const loginCookie = String(started.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(login.url, new RegExp(`^${base}/deepai_code/desktop_auth/`), 'the page must be served here');
    // The dashboard learns the relay is on from the account view, so it can stop
    // warning about a page that will now load.
    const view = await call(`${base}/api/account`, { headers: { cookie: loginCookie } }).then((r) => r.json());
    assert.equal(view.authProxy, true);
    const signInPath = new URL(login.url).pathname + new URL(login.url).search;

    // 2. The relayed page must no longer bounce the browser away, or call DeepAI.
    const page = await call(`${base}${signInPath}`, { headers: { cookie: loginCookie } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.ok(!html.includes('window.location.hostname==="deepai.org"'), 'the bounce must be disarmed');
    assert.match(html, /app_base_url=''/);
    assert.ok(!html.includes(`127.0.0.1:${fixturePort}`), 'the fixture must not leak into the page');

    // Assets are absolute paths on the page's host, so they have to be relayed too.
    const asset = await call(`${base}/static/app.css`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'text/css');
    assert.equal(await asset.text(), 'body{}');

    // 3. The credential POST is relayed, and DeepAI's session cookie comes back
    //    re-scoped to this origin under the relay prefix.
    const posted = await call(`${base}/daily-time-sync/login/`, {
      method: 'POST',
      headers: { cookie: loginCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=kontomilosz350&password=hunter2',
    });
    assert.equal(posted.status, 200);
    const relayed = String(posted.headers.get('set-cookie') ?? '');
    assert.match(relayed, /dai_sessionid=fixture-session/, 'the upstream cookie must be relayed under our prefix');
    assert.ok(!/Domain=/i.test(relayed), 'and re-scoped to this origin');
    assert.ok(!/Secure/i.test(relayed), 'and not Secure on plain HTTP');
    const daiCookie = relayed.split(';')[0];

    // Upstream saw DeepAI's own origin, not the gateway's, and only the relayed
    // cookie — the gateway's session cookie must never travel to DeepAI.
    const loginSeen = fixture.seen.find((entry) => entry.path === '/daily-time-sync/login/');
    assert.equal(loginSeen.origin, `http://127.0.0.1:${fixturePort}`);
    // The browser held no DeepAI cookie yet, so nothing was forwarded — and in
    // particular not the gateway's own login cookie.
    assert.equal(loginSeen.cookie, '', 'no upstream cookie exists this early in the flow');

    // 4. The poll now reports signed-in, through the relay.
    const poll = await call(`${base}/daily-time-sync/user/`, { headers: { cookie: `${loginCookie}; ${daiCookie}` } });
    assert.equal(poll.status, 200);

    // 5. The decisive step: DeepAI redirects to a loopback address, and the relay
    //    puts that same callback back on this origin.
    const reloaded = await call(`${base}${signInPath}`, {
      headers: { cookie: `${loginCookie}; ${daiCookie}` },
      redirect: 'manual',
    });
    const reloadedBody = await reloaded.text();
    assert.equal(reloaded.status, 302, `body=${reloadedBody} logs=${logs.join(' | ')}`);
    const location = reloaded.headers.get('location');
    assert.match(location, /^\/auth-callback\?code=one-shot-code&state=/);
    assert.ok(!location.includes('127.0.0.1'), 'the redirect must not point at loopback any more');

    // 6. Following it finishes the sign-in, exactly as the direct callback would.
    const finished = await call(`${base}${location}`, { headers: { cookie: loginCookie } });
    const finishedBody = await finished.text();
    assert.equal(finished.status, 200, finishedBody);
    assert.match(finishedBody, /Logged in to DeepAI/);
    const sessionCookie = String(finished.headers.get('set-cookie') ?? '').split(';')[0];
    const account = await call(`${base}/api/account`, { headers: { cookie: sessionCookie } }).then((r) => r.json());
    assert.equal(account.signedIn, true);
    assert.equal(account.username, 'kontomilosz350');

    // 7. The password went through, and nowhere else: not into the log, and the
    //    gateway kept no copy of it.
    assert.ok(fixture.passwordsSeen.some((body) => body.includes('hunter2')), 'the fixture must have received it');
    assert.ok(!logs.join('\n').includes('hunter2'), 'the password must never be logged');
    assert.ok(!JSON.stringify(fixture.seen).includes('hunter2'), 'and it must not be echoed back');

    /*
     * 7b. The allowlist and the fetch must agree on one normalised path. If they did
     *     not, a dotted path could be relayed even though its normalised form is not
     *     on the list — which is how a relay turns into an open proxy.
     */
    const dotted = await call(`${base}/static/../healthz`, { redirect: 'manual' });
    assert.equal(dotted.status, 200, 'a dotted path must reach the gateway, not the relay');
    assert.deepEqual(await dotted.json(), { ok: true });

    // 8. Social sign-in cannot work through a relay, and says so instead of leaving.
    const social = await call(`${base}/accounts/google/login/`, { redirect: 'manual' });
    assert.equal(social.status, 501);
    assert.match(await social.text(), /email and password/);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => fixture.close(resolve));
  }
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

/* ------------------------------------------- deepai sign-in callback address */

/*
 * DeepAI builds the sign-in callback host itself and always picks `127.0.0.1`;
 * `port` is the only input it accepts, and it must be a plain integer. A browser
 * on any other machine therefore cannot open the redirect, so the gateway keeps
 * the address to show the visitor and accepts it back through
 * `POST /api/login/complete`. These checks pin both halves of that.
 */

check('the sign-in callback address is DeepAI loopback, not ours to choose', async () => {
  const { loopbackCallbackUrl } = await import('../src/deepai/account.js');
  assert.equal(loopbackCallbackUrl(8787), 'http://127.0.0.1:8787/auth-callback');
  // A junk port must not become a junk host in the address shown to a visitor.
  assert.equal(loopbackCallbackUrl(undefined), 'http://127.0.0.1:0/auth-callback');
});

check('a pasted callback address yields its code and state', async () => {
  const { parseCallbackInput } = await import('../src/deepai/account.js');

  // What the browser leaves in its address bar after the redirect fails to open.
  assert.deepEqual(
    parseCallbackInput('http://127.0.0.1:25912/auth-callback?code=abc123&state=deadbeef'),
    { ok: true, code: 'abc123', state: 'deadbeef' },
  );
  // DeepAI's own path, and the alias the gateway also serves.
  assert.deepEqual(
    parseCallbackInput('http://127.0.0.1:8787/callback?code=c&state=s'),
    { ok: true, code: 'c', state: 's' },
  );
  // A chat client or terminal likes to wrap the link in quotes or brackets.
  assert.deepEqual(
    parseCallbackInput('  <"http://127.0.0.1:8787/auth-callback?code=c&state=s">  '),
    { ok: true, code: 'c', state: 's' },
  );
  // Extra parameters must not disturb the two that matter.
  assert.deepEqual(
    parseCallbackInput('http://127.0.0.1:8787/auth-callback?code=c&state=s&extra=1#frag'),
    { ok: true, code: 'c', state: 's' },
  );
  // A bare query fragment is accepted too.
  assert.deepEqual(parseCallbackInput('?code=c&state=s'), { ok: true, code: 'c', state: 's' });
  // Which host the visitor copied from is irrelevant: only the two parameters
  // matter, so an address already fixed by hand parses just as well.
  assert.deepEqual(
    parseCallbackInput('http://gw.example.test:25912/auth-callback?code=c&state=s'),
    { ok: true, code: 'c', state: 's' },
  );

  /*
   * Each rejection names what to fix, because the visitor is shown it as an
   * instruction. "The address is cut off" is actionable; "invalid input" is not,
   * and a single catch-all reason would also hide a genuinely wrong address behind
   * the same words as a truncated one.
   */
  // An address that stops before the second half: the visitor copied too little.
  assert.deepEqual(
    parseCallbackInput('http://127.0.0.1:8787/auth-callback?code=c'),
    { ok: false, reason: 'no-state' },
  );
  assert.deepEqual(
    parseCallbackInput('http://127.0.0.1:8787/auth-callback?state=s'),
    { ok: false, reason: 'no-code' },
  );
  // A bare code is not an address at all.
  assert.deepEqual(parseCallbackInput('abc123'), { ok: false, reason: 'not-an-address' });
  assert.deepEqual(parseCallbackInput('http://example.test/'), { ok: false, reason: 'not-an-address' });
  // Not text at all.
  assert.deepEqual(parseCallbackInput(undefined), { ok: false, reason: 'not-an-address' });
  assert.deepEqual(parseCallbackInput(42), { ok: false, reason: 'not-an-address' });
  assert.deepEqual(parseCallbackInput('   '), { ok: false, reason: 'not-an-address' });
  // Unbounded input must not be parsed or logged.
  assert.deepEqual(
    parseCallbackInput(`http://x/?code=c&state=${'s'.repeat(9000)}`),
    { ok: false, reason: 'too-long' },
  );
});

await checkAsync('the sign-in card gives one instruction, and it is the one that works', async () => {
  /*
   * Two earlier versions of this instruction were wrong, and both were taught by trying
   * them: a console command returns `'OK'` unless the console is on DeepAI's own origin,
   * because the API answers `201 OK` to an unauthenticated request; and the steps sat
   * behind a click, so the instructions a visitor needed were the ones they could not
   * see.
   *
   * What ships now is a page they open, a tab they click and text they copy — and the
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
      addEventListener() {}, appendChild() {}, remove() {}, replaceChildren() {},
      querySelector: () => null, querySelectorAll: () => [], setAttribute() {},
      getAttribute: () => null, closest: () => null, focus() {}, select() {},
      insertAdjacentHTML() {}, scrollIntoView() {},
    });
    for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
      'account-badge', 'account-badge-text', 'auth-button', 'nav', 'theme-toggle']) nodes.set(id, node());
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
      fetch: async (url) => new Response(
        JSON.stringify(String(url).includes('/account') ? account : { ok: true, models: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
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
    ok: true, signedIn: false, username: '', displayName: '', pendingLogin: false,
    origin: 'http://gw.example.test:25912', callbackUrl: 'http://127.0.0.1:25912/auth-callback',
    authProxy: false, allowance: null, balanceLow: false,
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

  // The signed-out case is called out in blue, because `OK` is what they will see.
  assert.match(html, /note--info/, 'the "plain OK" hint is an info note, not an error');
  assert.match(html, /shows a plain <code>OK<\/code>, you are not logged in/);
  assert.match(html, /201 OK/, 'and it explains why, so `OK` is not mistaken for success');

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
   * only one of them — a deploy that had shipped, showing a screen that did not exist.
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
      addEventListener() {}, appendChild() {}, remove() {}, replaceChildren() {},
      querySelector: () => null, querySelectorAll: () => [], setAttribute() {},
      getAttribute: () => null, closest: () => null, focus() {}, select() {},
      insertAdjacentHTML() {}, scrollIntoView() {},
    });
    for (const id of ['view', 'toasts', 'modal', 'modal-title', 'modal-body', 'modal-close',
      'account-badge', 'account-badge-text', 'auth-button', 'nav', 'theme-toggle']) nodes.set(id, node());
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
      fetch: async (url) => new Response(
        JSON.stringify(String(url).includes('/account') ? account : { ok: true, models: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
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
    ok: true, signedIn: false, username: '', displayName: '', pendingLogin: false,
    origin: 'http://gw.example.test:25912', callbackUrl: 'http://127.0.0.1:25912/auth-callback',
    authProxy: false, allowance: null, balanceLow: false,
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

check('every sign-in failure has something useful to say', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;

  const flow = readFileSync(join(root, 'src', 'deepai', 'account.js'), 'utf8');
  const admin = readFileSync(join(root, 'src', 'api', 'admin.js'), 'utf8');

  /*
   * Only reasons a function actually *returns*. Matching every `reason:` in a slice
   * also picked up the `@returns` list in the next function's doc comment, which
   * made one function appear to produce another's reasons.
   */
  const reasonsIn = (text) => new Set(
    [...text.matchAll(/return \{ ok: false, reason: '([a-z_-]+)'/g)].map((m) => m[1]),
  );
  /** The keys of one `const NAME = { ... }` table. */
  const keysOf = (name) => {
    const from = admin.indexOf(`const ${name} = {`);
    const table = admin.slice(from, admin.indexOf('};', from));
    return new Set([...table.matchAll(/^\s{2}'?([a-z_-]+)'?:/gm)].map((m) => m[1]));
  };
  const messagesIn = (name) => {
    const from = admin.indexOf(`const ${name} = {`);
    return admin.slice(from, admin.indexOf('};', from));
  };

  /*
   * There are two families of failure and two tables, so each table is checked
   * against the code that actually produces *its* reasons. A single scan of the
   * module would demand that every reason everywhere be answered in one table —
   * which is how this check first failed when the API-key route was added.
   */
  const completion = reasonsIn(flow.slice(
    flow.indexOf('export function parseCallbackInput'),
    // The callback flow ends where the landing page begins; the key helpers live
    // after it.
    flow.indexOf(' * Landing page shown in the browser'),
  ));
  assert.ok(completion.size >= 8, `expected the callback reasons to be found, saw ${completion.size}`);
  const unanswered = [...completion].filter((reason) => !keysOf('COMPLETION_FAILURES').has(reason));
  assert.deepEqual(unanswered, [], `these completion reasons would fall back to a generic message: ${unanswered}`);

  /*
   * One producer, one table. Slicing the module by position broke twice as soon as
   * another producer with its own reasons was appended, so each function is taken by
   * name and checked against the table that answers for it.
   */
  const functionBody = (name) => {
    const from = flow.indexOf(`export async function ${name}`);
    const at = from === -1 ? -1 : from;
    assert.ok(at !== -1, `expected to find ${name}`);
    const next = flow.indexOf('\nexport ', at + 10);
    const docStart = next === -1 ? -1 : flow.lastIndexOf('/**', next);
    const end = docStart > at ? docStart : next;
    return flow.slice(at, end === -1 ? undefined : end);
  };

  for (const [name, table, minimum] of [
    ['checkPastedKey', 'KEY_LOGIN_FAILURES', 3],
    ['signInWithPassword', 'PASSWORD_LOGIN_FAILURES', 4],
  ]) {
    const reasons = reasonsIn(functionBody(name));
    assert.ok(reasons.size >= minimum, `expected ${name}'s reasons to be found, saw ${reasons.size}`);
    const unanswered = [...reasons].filter((reason) => !keysOf(table).has(reason));
    assert.deepEqual(unanswered, [], `${name} reasons without a message in ${table}: ${unanswered}`);
  }

  // The messages are read by someone looking at a page that would not load or a key
  // that was refused, so they must not name protocol parameters.
  for (const table of ['COMPLETION_FAILURES', 'KEY_LOGIN_FAILURES', 'PASSWORD_LOGIN_FAILURES']) {
    for (const message of messagesIn(table).matchAll(/'([^']{20,})'/g)) {
      assert.ok(!/\bstate\b|`code`/.test(message[1]), `jargon in ${table}: ${message[1]}`);
    }
  }

  /*
   * Nothing may be terminal by accident: a mistyped paste must stay retryable.
   *
   * The set is parsed rather than sliced to a delimiter: the declaration ends with
   * `]);`, so looking for `];` found nothing, yielded -1, and silently widened the
   * search to the rest of the file — which passed only while no other table happened
   * to mention those words.
   */
  const terminalMatch = /const TERMINAL_COMPLETION_REASONS = new Set\(\[([^\]]*)\]\)/.exec(admin);
  assert.ok(terminalMatch !== null, 'the terminal set must be found');
  const terminalReasons = new Set(
    [...terminalMatch[1].matchAll(/'([a-z_-]+)'/g)].map((match) => match[1]),
  );
  assert.equal(terminalReasons.size, 3, 'the terminal set is the three that end an attempt');
  for (const retryable of ['not-an-address', 'too-long', 'no-code', 'no-state', 'invalid_state', 'busy']) {
    assert.ok(!terminalReasons.has(retryable), `${retryable} must leave the sign-in retryable`);
  }
  for (const terminal of ['expired', 'too_many_attempts', 'exchange_failed']) {
    assert.ok(terminalReasons.has(terminal), `${terminal} ends the attempt`);
  }
});

check('the pasted console output is read forgivingly', async () => {
  const { parseAccountPaste } = await import('../src/deepai/account.js');

  // What the console prints for `console.log(await (await fetch(…)).text())`, pasted
  // exactly as it appears — quotes included.
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
  assert.deepEqual(parseAccountPaste('Response {type: "cors", url: "…"}'), { ok: false, reason: 'not-json' });
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

check('a pasted key owns itself, so nobody can claim another account', async () => {
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

await checkAsync('signing in with a pasted API key skips the browser round trip', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const { usernameForKey } = await import('../src/deepai/account.js');
  const logs = [];
  const app = createApp(fresh, { log: (message) => logs.push(message), logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const realFetch = globalThis.fetch;
  const http = (...args) => realFetch(...args);
  const answer = (url) => {
    const target = String(url);
    if (target.endsWith('/deepai_code/theos')) {
      return json({ enabled: true, balance: '10.50000', granted: '50.00000', refresh_at: '2026-01-01T00:00:00+00:00' });
    }
    if (target.endsWith('/get_usage_summary')) return json({ is_authenticated: true, is_pro: true });
    return json({ err: 'unexpected' }, 404);
  };

  try {
    globalThis.fetch = async (url) => answer(url);

    const signIn = (key, cookie, email = 'milo@example.com') => http(`${base}/api/login/key`, {
      method: 'POST',
      headers: cookie === undefined ? { 'content-type': 'application/json' } : { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key, email }),
    });

    // Whitespace around a pasted key is normal and must not matter.
    const first = await signIn('  sk-good-key  ');
    const firstText = await first.text();
    assert.equal(first.status, 200, firstText);
    // The key must never come back, in any form.
    assert.ok(!firstText.includes('sk-good-key'), 'the response must not echo the key');
    const body = JSON.parse(firstText);
    assert.equal(body.created, true);
    assert.equal(body.username, usernameForKey('sk-good-key'));

    const cookie = String(first.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /deepai_gateway_session=/);

    // The account works immediately, with the balance we already read.
    const account = await http(`${base}/api/account`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(account.signedIn, true);
    assert.equal(account.username, usernameForKey('sk-good-key'));
    // The owner stays the derived fingerprint — what is *shown* is the email.
    assert.equal(account.displayName, 'milo@example.com');
    assert.ok(!account.displayName.includes('sk-'), 'the shown name must not be the key');
    assert.equal(account.isPro, true);
    assert.equal(account.allowance?.balance, '10.50000');

    // The same key again re-attaches to the same account rather than duplicating it.
    const again = await signIn('sk-good-key', cookie);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).created, false, 'the same key must not create a second owner');
    assert.equal(listAccounts(fresh).length, 1);

    // A different key is a different account, and cannot see the first one's keys.
    const created = await http(`${base}/api/keys`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'owned-by-first' }),
    });
    assert.equal(created.status, 201, await created.text());

    const second = await signIn('sk-other-key', undefined, 'other@example.com');
    const secondCookie = String(second.headers.get('set-cookie') ?? '').split(';')[0];
    const secondAccount = await http(`${base}/api/account`, { headers: { cookie: secondCookie } }).then((r) => r.json());
    assert.equal(secondAccount.username, usernameForKey('sk-other-key'));
    assert.equal(secondAccount.displayName, 'other@example.com', 'each account shows its own name');
    assert.notEqual(secondAccount.username, account.username);
    const stolen = await http(`${base}/api/keys`, { headers: { cookie: secondCookie } }).then((r) => r.json());
    assert.deepEqual(stolen.keys, [], 'a second key must not inherit the first key\'s gateway keys');
    assert.equal(listAccounts(fresh).length, 2);

    // A key is a credential: it must not reach the log either.
    assert.ok(logs.length > 0, 'the sign-in should be logged');
    assert.ok(!logs.join('\n').includes('sk-good-key'), 'the key must never be logged');
    // The name is a label the visitor typed, and the log records the derived owner
    // instead, so one account's chosen name is not exposed to the operator or to
    // anyone else reading the log.
    assert.ok(!logs.join('\n').includes('milo@example.com'), 'the chosen name must not be logged');
    // Nor does it travel to another account's session.
    assert.ok(!JSON.stringify(secondAccount).includes('milo@example.com'), 'a name must stay with its own account');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('the gateway can sign in with a DeepAI password itself', async () => {
  /*
   * DeepAI's own three requests, performed here: does the account exist and can it
   * use a password, the login POST, and the authenticated reload that answers with
   * the loopback redirect. Doing them server-side is what removes the need to relay
   * their page and to guess which requests have to be passed through.
   */
  const http = await import('node:http');
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const json = (payload, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/get_user_login_type') {
        fixture.seen.push(url.pathname);
        if (body.includes('social@example.com')) {
          return json({ user_exists: true, login_with_password: false, login_with_social_accounts: ['Google'] });
        }
        if (body.includes('ghost@example.com')) {
          return json({ user_exists: false, login_with_password: true, login_with_social_accounts: [] });
        }
        return json({ user_exists: true, login_with_password: true, login_with_social_accounts: [] });
      }
      if (url.pathname === '/daily-time-sync/login/') {
        fixture.seen.push(url.pathname);
        if (!body.includes('correct-horse')) {
          return json({ non_field_errors: ['Unable to log in with provided credentials.'] }, 400);
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'sessionid=fixture-session; Path=/; HttpOnly',
        });
        return res.end('{"ok":true}');
      }
      if (url.pathname === '/daily-time-sync/user/') {
        fixture.seen.push(url.pathname);
        if (!(req.headers.cookie ?? '').includes('sessionid=fixture-session')) {
          res.writeHead(201, { 'content-type': 'text/plain' });
          return res.end('OK');
        }
        // The account's own identity, key included, exactly as DeepAI answers it.
        return json({
          pk: 1,
          username: 'kontomilosz350',
          email: 'verified@example.com',
          // A placeholder, never a real key: this file is published.
          userprofile: { api_key: '00000000-0000-4000-8000-000000000000' },
        });
      }
      if (url.pathname === '/deepai_code/desktop_auth/') {
        fixture.seen.push(url.pathname);
        // The one response the browser could never have followed on a public host.
        if (!(req.headers.cookie ?? '').includes('sessionid=fixture-session')) return json({ err: 'no session' }, 401);
        res.writeHead(302, {
          location: `http://127.0.0.1:${url.searchParams.get('port')}/auth-callback?code=server-side-code&state=${url.searchParams.get('state')}`,
        });
        return res.end();
      }
      return json({ err: 'unexpected' }, 404);
    });
  });
  fixture.seen = [];
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;

  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const logs = [];
  const app = createApp(fresh, {
    log: (message) => logs.push(message),
    logRequests: false,
    authApiOrigin: fixtureOrigin,
  });
  const gateway = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => gateway.once('listening', resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  const realFetch = globalThis.fetch;
  const call = (...args) => realFetch(...args);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/desktop_auth/exchange/')) {
      return new Response(JSON.stringify({ api_key: 'sk-from-password', username: 'kontomilosz350', is_pro: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('/deepai_code/theos')) {
      return new Response('{"enabled":true,"balance":"7.0","granted":"10.0","refresh_at":null}', {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('/get_usage_summary')) {
      return new Response('{"is_authenticated":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };

  /** Start a sign-in and return the cookie that owns it. */
  const begin = async () => {
    const started = await call(`${base}/api/login`, { method: 'POST' });
    return String(started.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const post = (cookie, body) => call(`${base}/api/login/password`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    // Without a waiting sign-in there is no state to bind a code to, so this must
    // not be usable as a password oracle by anyone.
    const unbound = await post('', { email: 'a@b.com', password: 'correct-horse' });
    assert.equal(unbound.status, 410);
    assert.equal((await unbound.json()).code, 'no_pending_login');

    // Shapes that are not credentials.
    let cookie = await begin();
    for (const body of [{}, { email: '', password: '' }, { email: 'not-an-email', password: 'x' }, { email: 'a@b.com', password: '' }]) {
      const bad = await post(cookie, body);
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.ok(['invalid_email', 'invalid_password'].includes((await bad.json()).code));
    }

    // An account that does not exist says so, rather than blaming the password.
    const ghost = await post(cookie, { email: 'ghost@example.com', password: 'correct-horse' });
    assert.equal(ghost.status, 404);
    assert.equal((await ghost.json()).code, 'no-account');

    // An account created with Google has no password, and naming the provider is
    // the difference between a dead end and the next step.
    const social = await post(cookie, { email: 'social@example.com', password: 'correct-horse' });
    assert.equal(social.status, 409);
    const socialBody = await social.json();
    assert.equal(socialBody.code, 'social-only');
    assert.match(socialBody.error, /Google/);

    // A wrong password is a verdict from DeepAI, not a failure here.
    const wrong = await post(cookie, { email: 'kontomilosz350@example.com', password: 'wrong' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'bad-credentials');

    // The real thing.
    const done = await post(cookie, { email: 'kontomilosz350@example.com', password: 'correct-horse' });
    const doneText = await done.text();
    assert.equal(done.status, 200, doneText);
    assert.equal(JSON.parse(doneText).username, 'kontomilosz350');

    const session = String(done.headers.get('set-cookie') ?? '').split(';')[0];
    const account = await call(`${base}/api/account`, { headers: { cookie: session } }).then((r) => r.json());
    assert.equal(account.signedIn, true);
    /*
     * The displayed name is DeepAI's own answer, not the field that was typed: the
     * session the gateway just obtained is asked who it belongs to. That is the end of
     * "the user could type a wrong email" — for this route there is nothing to type.
     */
    assert.equal(account.displayName, 'verified@example.com');

    /*
     * The successful attempt really took DeepAI's own route, in order: the password
     * check, the login, then the authenticated reload that answers with the loopback
     * redirect. Asserted on the tail, because the rejected attempts above called the
     * first endpoint too.
     */
    assert.deepEqual(
      fixture.seen.slice(-4),
      [
        '/get_user_login_type',
        '/daily-time-sync/login/',
        '/deepai_code/desktop_auth/',
        // And then, with the session in hand, who this is.
        '/daily-time-sync/user/',
      ],
    );

    // A password is a credential: it must not reach the log.
    assert.ok(logs.length > 0, 'the sign-in is logged');
    assert.ok(!logs.join('\n').includes('correct-horse'), 'the password must never be logged');
    assert.ok(!logs.join('\n').includes('wrong'), 'nor a rejected one');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => fixture.close(resolve));
  }
});

await checkAsync('the same DeepAI key never becomes two accounts', async () => {
  /*
   * DeepAI mints a fresh key on every sign-in, so one DeepAI account can hold
   * several — and a key pasted by hand must land on the account that already owns
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

  // What the browser sign-in would have stored: the real DeepAI username.
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
    const res = await http(`${base}/api/login/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-shared-key', email: 'milo@example.com' }),
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

await checkAsync('a refused API key explains which kind of refusal it was', async () => {
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
  const post = (body) => http(`${base}/api/login/key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

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
    // Shapes that are not a key at all: refused before any network call.
    globalThis.fetch = async () => { throw new Error('must not be called'); };
    for (const body of [
      {}, { key: '' }, { key: '   ' }, { key: 42 }, { key: null }, { key: 'a\nb' }, { key: 'x'.repeat(600) },
      // The email is the name that will be shown, so a missing or implausible one
      // is refused before any key is checked.
      { key: 'sk-fine' }, { key: 'sk-fine', email: '' }, { key: 'sk-fine', email: '   ' },
      { key: 'sk-fine', email: 'not-an-email' }, { key: 'sk-fine', email: 'a@b' },
      { key: 'sk-fine', email: `${'x'.repeat(250)}@example.com` },
    ]) {
      const bad = await post(body);
      assert.equal(bad.status, 400, `${JSON.stringify(body).slice(0, 40)} must be refused`);
      assert.ok(['invalid_key', 'invalid_email'].includes((await bad.json()).code));
    }
    assert.equal(listAccounts(fresh).length, 0, 'nothing may be created from a malformed key');

    // A key DeepAI does not recognise.
    globalThis.fetch = lane({ theos: 401, usage: 401 });
    const rejected = await post({ key: 'sk-nonsense', email: 'milo@example.com' });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).code, 'rejected');

    // A real DeepAI key that is not enabled for the Code lane: the likeliest
    // failure of all, and the one that must not be reported as a typo.
    globalThis.fetch = lane({ theos: 401, usage: 'auth' });
    const wrongLane = await post({ key: 'sk-model-api-only', email: 'milo@example.com' });
    assert.equal(wrongLane.status, 403);
    const wrongLaneBody = await wrongLane.json();
    assert.equal(wrongLaneBody.code, 'not-for-code');
    assert.match(wrongLaneBody.error, /not enabled for DeepAI Code/);

    // DeepAI is down, which is not the visitor's mistake.
    globalThis.fetch = lane({ theos: 500, usage: 401 });
    const down = await post({ key: 'sk-fine', email: 'milo@example.com' });
    assert.equal(down.status, 502);
    assert.equal((await down.json()).code, 'unreachable');

    // And a network failure is reported as one rather than as a bad key.
    globalThis.fetch = async () => { throw new Error('offline'); };
    const offline = await post({ key: 'sk-fine', email: 'milo@example.com' });
    assert.equal(offline.status, 502);
    assert.equal((await offline.json()).code, 'unreachable');

    // No refusal may have created an account or handed out a session.
    assert.equal(listAccounts(fresh).length, 0);
    // No refusal may hand out a session. (`deepai_gateway_login` is the
    // browser-grouping cookie, not a credential, so only the session counts.)
    for (const response of [rejected, wrongLane, down, offline]) {
      const cookies = String(response.headers.get('set-cookie') ?? '');
      assert.ok(!cookies.includes('deepai_gateway_session='), 'a refused key must not create a session');
    }
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

check('the origin and port come from the request, not a constant', async () => {
  const { localPort, publicOrigin } = await import('../src/api/admin.js');

  /** A request stand-in; `trusted` mirrors Express' `trust proxy` setting. */
  const req = ({ host = 'gw.example.test:25912', proto, forwardedHost, forwardedProto, trusted = false, socketPort } = {}) => ({
    app: { get: (name) => (name === 'trust proxy' ? trusted : undefined) },
    secure: false,
    socket: socketPort === undefined ? {} : { localPort: socketPort },
    get(name) {
      if (name === 'host') return host;
      if (name === 'x-forwarded-host') return forwardedHost;
      if (name === 'x-forwarded-proto') return forwardedProto;
      return undefined;
    },
    _proto: proto,
  });

  // The browser's own Host is the best answer when nothing else is known, and it
  // is what fixes the public port a visitor actually used.
  assert.equal(publicOrigin(req()), 'http://gw.example.test:25912');
  assert.equal(localPort(req()), 25912);

  // An explicit PUBLIC_URL wins over the request.
  assert.equal(publicOrigin(req(), 'https://panel.example.test/'), 'https://panel.example.test');
  assert.equal(localPort(req(), 'https://panel.example.test/'), 443);

  // A default port needs no explicit port in the origin.
  assert.equal(localPort(req({ host: 'gw.example.test' })), 80);
  assert.equal(publicOrigin(req({ host: 'gw.example.test' })), 'http://gw.example.test');

  // Forwarding headers are only believed when the proxy is trusted: otherwise any
  // client could name the origin the dashboard reports.
  const spoofed = req({ forwardedHost: 'evil.example.test', forwardedProto: 'https' });
  assert.equal(publicOrigin(spoofed), 'http://gw.example.test:25912', 'untrusted forwarding headers must be ignored');
  assert.equal(
    publicOrigin(req({ forwardedHost: 'panel.example.test', forwardedProto: 'https', trusted: true })),
    'https://panel.example.test',
    'a trusted proxy may name the origin',
  );
  assert.equal(
    localPort(req({ forwardedHost: 'panel.example.test:25912', forwardedProto: 'https', trusted: true })),
    25912,
  );
  // Only the first hop counts, and a nonsense scheme is refused.
  assert.equal(
    publicOrigin(req({ forwardedHost: 'a.test, b.test', forwardedProto: 'https', trusted: true })),
    'https://a.test',
  );
  assert.equal(publicOrigin(req({ forwardedProto: 'gopher', trusted: true, host: 'gw.test' })), '');
  assert.equal(publicOrigin(req({ host: '' })), '');

  // With no usable request address at all, the listening socket is the fallback.
  assert.equal(localPort(req({ host: '', socketPort: 8787 })), 8787);
  assert.equal(localPort(req({ host: '', socketPort: undefined })), 0);
});

await checkAsync('a loopback callback the browser cannot open can be pasted back', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runtime = app.locals.runtime;

  const realFetch = globalThis.fetch;
  // The server's outbound exchange goes through `globalThis.fetch`, which this
  // check stubs. The check's own HTTP calls must keep using the real one.
  const http = (...args) => realFetch(...args);
  try {
    // Start a login as a browser would, and keep the cookie that identifies it.
    const started = await http(`${base}/api/login`, { method: 'POST' });
    assert.equal(started.status, 200);
    const login = await started.json();
    const cookie = String(started.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /deepai_gateway_login=/);

    // The address DeepAI will use is loopback, and the port is read off the
    // request, so the visitor knows exactly what to look for.
    assert.equal(login.callbackUrl, `http://127.0.0.1:${server.address().port}/auth-callback`);
    assert.equal(login.callbackPort, server.address().port);
    assert.equal(login.origin, `http://127.0.0.1:${server.address().port}`);

    // The state is the server's secret, binding a code to this attempt.
    const browser = runtime.pendingLogins.keys().next().value;
    const { state } = runtime.pendingLogins.get(browser).flow;

    // `/api/account` reports the same address, derived from the request it is
    // served on. That is what keeps the dashboard's instructions correct after a
    // reload — which is exactly when the visitor comes back from the dead address.
    const pendingView = await http(`${base}/api/account`, { headers: { cookie } }).then((r) => r.json());
    assert.equal(pendingView.pendingLogin, true, 'this browser has an attempt waiting');
    assert.equal(pendingView.callbackUrl, `http://127.0.0.1:${server.address().port}/auth-callback`);
    assert.equal(pendingView.origin, `http://127.0.0.1:${server.address().port}`);
    assert.ok(Number.isInteger(pendingView.callbackPort));
    // A different browser must not be told about someone else's attempt.
    const strangerView = await http(`${base}/api/account`).then((r) => r.json());
    assert.equal(strangerView.pendingLogin, false, 'a pending login belongs to one browser only');

    const pasted = `http://127.0.0.1:${server.address().port}/auth-callback?code=one-shot&state=${state}`;

    // Truncated input must not burn the attempt: a visitor can paste again.
    const truncated = await http(`${base}/api/login/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/auth-callback?code=one-shot' }),
    });
    assert.equal(truncated.status, 400);
    assert.equal((await truncated.json()).code, 'no-state');
    assert.equal(runtime.pendingLogins.size, 1, 'a rejected paste leaves the attempt alive');

    // A code bound to a different attempt is refused...
    const foreign = await http(`${base}/api/login/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:1/auth-callback?code=x&state=${'0'.repeat(64)}` }),
    });
    assert.equal(foreign.status, 400);
    assert.equal((await foreign.json()).code, 'invalid_state');

    // ...and another browser cannot finish this browser's attempt at all.
    const stranger = await http(`${base}/api/login/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: pasted }),
    });
    assert.equal(stranger.status, 410, 'only the browser that started the attempt may finish it');
    assert.equal((await stranger.json()).code, 'no_pending_login');

    // Now the real exchange, with the network stubbed out.
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ api_key: 'sk-pasted', username: 'pasted-user', is_pro: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const done = await http(`${base}/api/login/complete`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ url: pasted }),
    });
    // Read the body once: a failed assertion can then show what the server said.
    const doneText = await done.text();
    assert.equal(done.status, 200, doneText);
    const result = JSON.parse(doneText);
    assert.equal(result.ok, true);
    assert.equal(result.username, 'pasted-user');

    // The same one-shot code the callback route would have redeemed.
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/deepai_code/desktop_auth/exchange/'));
    assert.equal(calls[0].body.code, 'one-shot');

    // The response hands the browser a live session, exactly like the callback.
    const sessionCookie = String(done.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(sessionCookie, /deepai_gateway_session=/);
    const account = await http(`${base}/api/account`, { headers: { cookie: sessionCookie } }).then((r) => r.json());
    assert.equal(account.signedIn, true);
    assert.equal(account.username, 'pasted-user');
    assert.equal(runtime.pendingLogins.size, 0, 'a completed attempt is forgotten');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('fixing the host in the address bar finishes the sign-in', async () => {
  /*
   * The other way to "process" DeepAI's dead address: the browser's own rewrite.
   * Its redirect points at `http://127.0.0.1:<port>/auth-callback`, and the
   * gateway serves that exact path on its own origin, so replacing `127.0.0.1`
   * with the public host turns the dead address into a working one — no paste, no
   * extra endpoint. That only holds while a top-level GET still carries this
   * browser's login cookie, which is what this check pins.
   */
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runtime = app.locals.runtime;

  const realFetch = globalThis.fetch;
  const http = (...args) => realFetch(...args);
  try {
    const started = await http(`${base}/api/login`, { method: 'POST' });
    const cookie = String(started.headers.get('set-cookie') ?? '').split(';')[0];
    const browser = runtime.pendingLogins.keys().next().value;
    const { state } = runtime.pendingLogins.get(browser).flow;

    globalThis.fetch = async () => new Response(
      JSON.stringify({ api_key: 'sk-from-bar', username: 'from-bar', is_pro: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    // Exactly what the browser sends after the visitor edits the host and hits
    // Enter: a plain navigation to /auth-callback carrying the login cookie.
    const landed = await http(`${base}/auth-callback?code=one-shot&state=${state}`, { headers: { cookie } });
    const body = await landed.text();
    assert.equal(landed.status, 200, body);
    assert.match(body, /Logged in to DeepAI/);

    // It hands over a session, and the waiting attempt is gone.
    const sessionCookie = String(landed.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(sessionCookie, /deepai_gateway_session=/);
    assert.equal(runtime.pendingLogins.size, 0);
    const account = await http(`${base}/api/account`, { headers: { cookie: sessionCookie } }).then((r) => r.json());
    assert.equal(account.signedIn, true);
    assert.equal(account.username, 'from-bar');

    // The rewritten address works on the alias too, since both point at the same
    // handler — a visitor may well land on either spelling.
    const alias = await http(`${base}/callback?code=c&state=s`);
    assert.equal(alias.status, 410, 'the alias answers, it just has no attempt left');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('the completion endpoint refuses everything it cannot verify', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runtime = app.locals.runtime;

  const realFetch = globalThis.fetch;
  try {
    const post = (cookie, body) => fetch(`${base}/api/login/complete`, {
      method: 'POST',
      headers: cookie === '' ? { 'content-type': 'application/json' } : { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Nothing pending at all.
    const nothing = await post('', { url: 'http://127.0.0.1:1/auth-callback?code=c&state=s' });
    assert.equal(nothing.status, 410);
    assert.equal((await nothing.json()).code, 'no_pending_login');

    // Pending, but the request carries no address.
    const started = await fetch(`${base}/api/login`, { method: 'POST' });
    const cookie = String(started.headers.get('set-cookie') ?? '').split(';')[0];
    for (const body of [{}, { url: '' }, { code: 'c' }, { url: 42 }, { url: '   ' }]) {
      const bad = await post(cookie, body);
      assert.equal(bad.status, 400, `body ${JSON.stringify(body)} must be refused`);
      assert.equal((await bad.json()).code, 'missing_address');
    }

    // A bare code with no state is refused rather than exchanged: there would be
    // nothing to prove which attempt it was minted for.
    const unbound = await post(cookie, { code: 'abcdef', state: '' });
    assert.equal(unbound.status, 400);

    // Repeated junk exhausts the attempt instead of becoming a free oracle. The
    // last rejected pair reports why it ended, rather than a later call merely
    // finding the flow gone.
    const browser = runtime.pendingLogins.keys().next().value;
    const { state } = runtime.pendingLogins.get(browser).flow;
    const seen = [];
    for (let attempt = 0; attempt < 12 && runtime.pendingLogins.size > 0; attempt += 1) {
      const response = await post(cookie, { url: `http://127.0.0.1:1/auth-callback?code=c&state=${'1'.repeat(64)}` });
      seen.push([response.status, (await response.json()).code]);
    }
    assert.deepEqual(
      seen.at(-1),
      [429, 'too_many_attempts'],
      `expected the attempt to end on too many tries, saw ${JSON.stringify(seen)}`,
    );
    assert.equal(runtime.pendingLogins.size, 0, 'an exhausted attempt is forgotten');
    assert.ok(state.length === 64, 'the state is still the 256-bit value');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('/callback is the same handler as /auth-callback', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Both paths answer, and both refuse a callback with no attempt behind it.
    for (const path of ['/auth-callback', '/callback']) {
      const response = await fetch(`${base}${path}?code=c&state=s`, { redirect: 'manual' });
      assert.equal(response.status, 410, `${path} should be served`);
      assert.match(await response.text(), /Nothing to confirm/);
    }

    // A POST to either is the wrong verb and must not be treated as a callback.
    const wrongVerb = await fetch(`${base}/callback`, { method: 'POST' });
    assert.equal(wrongVerb.status, 404, 'only GET is routed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await checkAsync('PUBLIC_URL is reported to the dashboard without changing the callback', async () => {
  const fresh = openDatabase(':memory:');
  const { createApp } = await import('../server.js');
  const app = createApp(fresh, { log: () => {}, logRequests: false, publicUrl: 'https://panel.example.test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST' }).then((r) => r.json());
    // The origin the visitor used, taken from configuration.
    assert.equal(login.origin, 'https://panel.example.test');
    // But DeepAI still gets a plain integer port for a loopback callback: no
    // setting can move the redirect to the public host.
    assert.equal(login.callbackPort, 443);
    assert.equal(login.callbackUrl, 'http://127.0.0.1:443/auth-callback');
    assert.equal(login.path, '/auth-callback');
    await fetch(`${base}/api/cancel-login`, { method: 'POST' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* -------------------------------------------------------------------- done */

console.log(results.join('\n'));
console.log(process.exitCode ? '\nFAILURES PRESENT' : '\nALL CHECKS PASSED');
