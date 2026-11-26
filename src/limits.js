/**
 * Transport limits shared by the HTTP server and the plugin manifest.
 *
 * It is a body limit, not a prompt budget: the gateway does not refuse a conversation by
 * estimating its token count before sending it.
 *
 * @module deepai-gateway/limits
 */

export const REQUEST_BODY_LIMIT = '50mb';
export const REQUEST_BODY_BYTES = 50 * 1024 * 1024;
