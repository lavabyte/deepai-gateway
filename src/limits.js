/**
 * The transport limit the HTTP server accepts.
 *
 * It is a body limit, not a prompt budget: the gateway does not refuse a conversation by
 * estimating its token count before sending it.
 *
 * @module deepai-gateway/limits
 */

export const REQUEST_BODY_LIMIT = '50mb';
