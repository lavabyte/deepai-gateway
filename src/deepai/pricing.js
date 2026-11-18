/**
 * What a paid model costs, as an equation on the catalog's own price rather than a table.
 *
 * The catalog carries `theosPerRequest` - 2 for MiniMax M3, 10 for Claude Sonnet 5.5, 20 for
 * Claude Fable 5.2 - and the desktop app prints it as "2 Theos/request" with the note that
 * "actual charges depend on token usage". It does, and the number is not the charge: a real
 * request measured 0.0082 for a model whose row says 2. So the price is a tier, not an amount,
 * and what a tier costs per token follows a rule simple enough to write down.
 *
 * Measured on one account, through the gateway's own headers, against the live endpoint, with
 * content the model had never seen (a repeated prompt measures the cache, not the price), reading
 * the balance before and after each request because nothing in the payload carries a cost. The
 * rate is per million *weighted* tokens, where a completion token weighs four - the ratio a
 * two-rate fit produced from a request of 201 prompt and 900 completion tokens costing 0.12030
 * and one of 29,282 and 20 costing 0.92931.
 *
 *     price   measured Credits / 1M      equation
 *         5            103                 107
 *         6            129                 123
 *         8            163                 162
 *        10       216, 217, 216, 206       214
 *        15       435, 435, 395            428
 *        20            869                 856
 *
 * That is a doubling every 5 of price, and every point above is within 8% of the equation:
 *
 *     Credits per million = 214 * 2 ^ ((price - 10) / 5)
 *
 * Two measurements fall below it - MiniMax M3 at price 2 measured 31.7 where the equation says
 * 71, and Kimi K3 at price 3 measured 28 to 50 where it says 81 - and both came from deltas so
 * small that the balance's batched updates could not resolve them; the fit is on the tiers from 5
 * up, where a single request moves the balance enough to read. The equation is used for those
 * cheap tiers anyway: it is an extrapolation, it is labelled as a price rather than a
 * measurement, and it is wrong by less than the catalog was wrong by.
 *
 * The equation is written per million because that is the unit the measurements are in. What the
 * pages show is the same rate per minute of generation - `~0.60 Credits / min` for the price-10
 * group - because DeepAI Code itself prices in minutes ("Theos are spent per minute of active
 * session time"), and because a minute is the quantity a person can picture. The per-thousand rate
 * stays in the answer for a caller pricing its own token count.
 *
 * The top tier is an extrapolation too, and a much larger one: price 50 doubles past the last
 * measured tier four more times, to 54,784 Credits per million. Nothing was sold at that price on
 * this account to check it against - the endpoint answers 404 for GPT-6 Astra - so it is shown as
 * what the rule says, not as something seen.
 *
 * @module deepai-gateway/deepai/pricing
 */

/** How much one completion token costs relative to one prompt token, as measured. */
export const COMPLETION_WEIGHT = 4;

/**
 * The fitted constant: Credits per million weighted tokens at catalog price 10.
 *
 * Every tier in the table above was measured against a balance that had moved by at least 0.1
 * Credits, and 214 sits in the middle of the four measurements at this price.
 */
export const CREDITS_PER_MILLION_AT_TEN = 214;

/**
 * How many tokens a paid model gets through in a minute of generation, measured.
 *
 * The number the pages need is not per token but per minute, because that is how the desktop app
 * states its own price - "Theos are spent per minute of active session time at a rate set by the
 * model and reasoning effort" - and because a minute is a quantity a person can picture.
 *
 * Two runs, balance read before and after, both on tiers this account can afford:
 *
 *     minimax-m3   price 2   3,000 completion tokens in 65.9 s   2,730 tokens/min
 *     claude-sonnet-5-5  10  2,500 completion tokens in 52.3 s   2,866 tokens/min
 *
 * 2,800 is the middle of those two. It is a speed, not a price: a faster model buys more tokens
 * per minute and a slower one fewer, and a session that streams nothing costs nothing, which is
 * why the figure is labelled as a rate during generation and never as a charge per minute of
 * being open.
 */
export const TOKENS_PER_MINUTE = 2_800;

/** How much catalog price doubles the rate. Measured 5.01 across the fitted tiers. */
export const PRICE_DOUBLING_POINTS = 5;

/**
 * Credits per million weighted tokens for a catalog price.
 *
 * The doubling is the whole model: a tier that costs twice as much in the catalog costs twice as
 * much per token, and five price points are what twice means. A free model is zero, and a price
 * the catalog did not send is `null` rather than a number - a paid model must never read as free.
 *
 * @param {string|number|null|undefined} theosPerRequest - the catalog's price for the tier.
 * @returns {number|null} Credits per million weighted tokens.
 */
export function creditsPerMillion(theosPerRequest) {
  const price = Number(theosPerRequest);
  if (!Number.isFinite(price)) return null;
  if (price <= 0) return 0;
  return CREDITS_PER_MILLION_AT_TEN * 2 ** ((price - 10) / PRICE_DOUBLING_POINTS);
}

/**
 * What one request cost, by the equation.
 *
 * @param {string|number|null|undefined} theosPerRequest
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number|null} Credits, or `null` when the catalog sent no price.
 */
export function creditsForUsage(theosPerRequest, promptTokens, completionTokens) {
  const rate = creditsPerMillion(theosPerRequest);
  if (rate === null) return null;
  const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0;
  const completion = Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : 0;
  return (rate * (prompt + COMPLETION_WEIGHT * completion)) / 1_000_000;
}

/**
 * The same rate per thousand tokens, which is the unit the pages show.
 *
 * The equation is fitted and documented per million because that is the size at which a real
 * request moves a balance enough to read. A page showing it has the opposite problem: every tier
 * under 20 comes out as a fraction of a Credit per thousand tokens - 0.21 for the price-10 group -
 * and a reader can multiply a token count by that in their head. Both units are the same number; a
 * thousand is simply the one a person can hold.
 *
 * @param {string|number|null|undefined} theosPerRequest
 * @returns {number|null} Credits per thousand weighted tokens.
 */
export function creditsPerThousand(theosPerRequest) {
  const rate = creditsPerMillion(theosPerRequest);
  return rate === null ? null : rate / 1000;
}

/**
 * What a minute of that model's generation costs, by the equation and the measured speed.
 *
 * The same rate as `creditsPerThousand`, with the token count a minute buys applied to it:
 * `creditsPerMillion * TOKENS_PER_MINUTE / 1e6`. Nothing new is being claimed - this is the token
 * price restated in the unit the desktop app uses for its own prices.
 *
 * @param {string|number|null|undefined} theosPerRequest
 * @returns {number|null} Credits per minute of generation.
 */
export function creditsPerMinute(theosPerRequest) {
  const rate = creditsPerMillion(theosPerRequest);
  return rate === null ? null : (rate * TOKENS_PER_MINUTE) / 1_000_000;
}

/**
 * The rate as a label, for an answer that wants a string: what a minute of generation costs,
 * unrounded. The model pages do not use it - they state DeepAI's own price per request - so this is
 * the string form of the two API fields below, and nothing else depends on it.
 *
 * `~0.60 Credits / min` for the price-10 group, `~0.20` for the cheapest paid tier, `~153.40` for
 * the extrapolated top. Unrounded because rounding to whole Credits turned six of the sixteen paid
 * tiers into `~0` - price 2, 3, 5, 5, 8 and 10 all collapsed to the same nothing - and a price list
 * where most of the paid models read as free is worse than no price list.
 *
 * Two decimals at 0.1 and above, three below, which is the rule this label has always had: a
 * fraction of a Credit needs the third digit to stay apart from its neighbour, a whole Credit does
 * not. The `~` stays, because neither the equation nor the measured speed behind the minute is
 * exact to the last digit - it marks the number as about-right without pretending it is 0.
 *
 * A free model is `Unmetered`; a model with no price at all is `Unknown`, never `0`.
 *
 * @param {string|number|null|undefined} theosPerRequest
 * @returns {string}
 */
export function rateLabelFor(theosPerRequest) {
  const rate = creditsPerMinute(theosPerRequest);
  if (rate === null) return 'Unknown';
  if (rate === 0) return 'Unmetered';
  const digits = rate >= 0.1 ? 2 : 3;
  return `~${rate.toFixed(digits)} Credits / min`;
}
