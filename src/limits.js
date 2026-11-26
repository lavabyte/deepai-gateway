/**
 * Transport limits shared by the HTTP server and the plugin manifest.
 *
 * `REQUEST_BODY_LIMIT` is what `express.json` accepts. `REQUEST_BODY_BYTES` is the same
 * number in bytes, for clients that want to budget before they send a body.
 *
 * @module deepai-gateway/limits
 */

export const REQUEST_BODY_LIMIT = '50mb';
export const REQUEST_BODY_BYTES = 50 * 1024 * 1024;
