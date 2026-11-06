#!/usr/bin/env node
/**
 * Ask DeepAI what it thinks of one account key.
 *
 * Written because a refusal here is easy to misread: DeepAI has three separate answers that
 * all look like "no" from the dashboard - the key is unknown, the key is real but not
 * enabled for DeepAI Code, or the gateway is speaking a lane revision DeepAI has retired -
 * and they need different fixes. The dashboard now separates them, but a gateway that
 * predates that separation, or a deployment whose messages have been lost, leaves the
 * question open. This answers it directly.
 *
 * The key is read from the command line, used for three requests, printed nowhere.
 *
 *   node scripts/check-key.js <api-key>
 *   npm run check-key -- <api-key>
 */

import { API_ORIGIN, LANE_HEADERS, LANE_VERSION } from '../src/deepai/wire.js';

const key = process.argv[2] ?? '';

if (key.trim() === '') {
  console.error('Usage: node scripts/check-key.js <api-key>');
  console.error('');
  console.error('The key is on https://deepai.org/dashboard/profile - but see the note at');
  console.error('the end of the output: that page issues keys for the model API, and');
  console.error('DeepAI Code wants one of its own.');
  process.exit(2);
}

const headers = { ...LANE_HEADERS, 'Api-Key': key, accept: 'application/json' };

/** One request, reduced to what the answer means. Never touches the body of a success. */
async function probe(label, url, init = {}) {
  try {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(20_000) });
    let code = '';
    const text = await response.text().catch(() => '');
    try { code = JSON.parse(text)?.error?.code ?? ''; } catch { /* not JSON */ }
    return { label, status: response.status, code, text };
  } catch (error) {
    return { label, status: 0, code: 'unreachable', text: String(error?.message ?? error) };
  }
}

console.log(`lane revision sent: ${LANE_VERSION}`);
console.log('');

const allowance = await probe('allowance', `${API_ORIGIN}/deepai_code/theos`);
const identity = await probe('model API', `${API_ORIGIN}/get_usage_summary`);
/*
 * A deliberately unusable model name: DeepAI checks the key before the request body, so a
 * refused key answers 401 and an accepted one answers something else. That makes this an
 * authentication probe that cannot generate a token or spend a credit.
 */
const lane = await probe('Code lane', `${API_ORIGIN}/deepai_code/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: '__auth_probe__', messages: [{ role: 'user', content: 'x' }], stream: false }),
});

const say = (name, result) => {
  const detail = result.code === '' ? '' : ` (${result.code})`;
  console.log(`  ${name.padEnd(12)} HTTP ${result.status || '-'}${detail}`);
};
say('allowance', allowance);
say('model API', identity);
say('Code lane', lane);

console.log('');

if (allowance.status === 426 || lane.status === 426) {
  console.log('VERDICT: the gateway lane revision is retired.');
  console.log('  DeepAI refused before reading the key. Set LANE_VERSION in src/deepai/wire.js to a');
  console.log('  revision that answers 401 with a deliberately wrong key, and this will work again.');
  process.exit(1);
}
/*
 * The allowance answer is the strongest signal there is: it is the very call the gateway
 * makes to accept a key, so a 200 here settles the question on its own. The Code-lane probe
 * only decides the cases where the allowance was refused.
 */
if (allowance.status === 200 || (lane.status !== 401 && lane.status !== 0)) {
  console.log('VERDICT: the key works for DeepAI Code.');
  if (allowance.status === 200) {
    console.log(`  The allowance answered 200${allowance.text.includes('balance') ? ' with a balance' : ''}, which is the call the`);
    console.log('  gateway itself makes. Any refusal on the dashboard is a gateway-side problem,');
    console.log('  not a problem with this key.');
  }
  process.exit(0);
}
if (lane.status === 401 && identity.status === 200) {
  let authenticated = false;
  try { authenticated = JSON.parse(identity.text)?.is_authenticated === true; } catch { /* leave false */ }
  if (authenticated) {
    console.log('VERDICT: the key is real, but DeepAI Code does not accept it.');
    console.log('  DeepAI issues keys for its model API at /dashboard/profile, and DeepAI Code wants');
    console.log('  a key of its own - the one its app is given when it signs in. This gateway can');
    console.log('  fetch one from DeepAI\'s own sign-in page: start it with CALLBACK_LOGIN=1 and use');
    console.log('  "Use DeepAI\'s sign-in page" on the sign-in card.');
  } else {
    console.log('VERDICT: DeepAI does not know this key at all.');
    console.log('  It is not a permission problem - copy it again, or make a new one at');
    console.log('  https://deepai.org/dashboard/profile.');
  }
  process.exit(1);
}
console.log('VERDICT: inconclusive - see the statuses above.');
process.exit(1);
