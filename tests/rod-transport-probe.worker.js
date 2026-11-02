/**
 * Read-only Cloudflare Workers transport probe for the ROD API.
 * Runs independently of the game Worker: no WIF, Supabase, signing or broadcast.
 * Test on Cloudflare's edge with: wrangler dev --remote --config tests/wrangler.rod-probe.jsonc
 */
const HOST = 'api.spacexpanse.org';
const PORT = 1234;
const INFO_URL = `https://${HOST}:${PORT}/info`;
const TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 16384;

const ALLOWED_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED', 'ERR_SSL_WRONG_VERSION_NUMBER'
]);

/** Regex categorization is suggestive, not authoritative; retain a sanitized message. */
export function summarizeError(error) {
  const message = String(error?.message ?? error ?? 'unknown error');
  const cause = error?.cause;
  const code = [error?.code, cause?.code].find(value => ALLOWED_ERROR_CODES.has(value)) ?? null;
  const combined = [message, String(cause?.message ?? ''), code ?? ''].join(' ');
  let category = 'unclassified';
  if (/ENOTFOUND|EAI_AGAIN|\bDNS\b|resolve|NXDOMAIN|name lookup/i.test(combined)) category = 'dns_possible';
  else if (/certificate|\bcert\b|\bTLS\b|\bSSL\b|handshake|hostname mismatch|SELF_SIGNED|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY/i.test(combined)) category = 'tls_possible';
  else if (/ECONNREFUSED|connection refused/i.test(combined)) category = 'connection_refused';
  else if (/ETIMEDOUT|timed?\s*out|AbortError|TimeoutError|aborted/i.test(combined)) category = 'timeout';
  else if (/disallowed|blocked|not permitted|port.*prohibited|proxy request failed|TCP Loop/i.test(combined)) category = 'platform_policy_possible';
  else if (/ECONNRESET|reset by peer|connection reset/i.test(combined)) category = 'connection_reset';
  else if (/network|connect|fetch failed|socket/i.test(combined)) category = 'transport_unspecified';
  // Avoid echoing endpoint URLs, query strings, authorization values or private addresses.
  const safeMessage = message.slice(0, 300)
    .replace(/https?:\/\/[^\s,;)}]+/gi, '[url]')
    .replace(/(?:authorization|bearer|password|secret|token)[=: ]+[^\s,;)}]+/gi, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .slice(0, 180);
  const name = /^(?:[A-Z][A-Za-z]*Error|Error)$/.test(String(error?.name ?? '')) ? error.name : 'Error';
  return { name, code, category, message: safeMessage };
}

function elapsed(start, now) { return Math.max(0, Math.round(now() - start)); }

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return { response_shape: 'no_body' };
  let received = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) return { response_shape: 'too_large' };
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    // ROD API uses {error: null, result: {chain, blocks, ...}}.
    const result = body?.result;
    if (body?.error != null) return { response_shape: 'api_error', api_error_code: Number.isInteger(body.error?.code) ? body.error.code : null };
    return { response_shape: 'json', chain: typeof result?.chain === 'string' ? result.chain.slice(0, 24) : null,
      blocks: Number.isSafeInteger(result?.blocks) ? result.blocks : null };
  } catch { return { response_shape: 'non_json' }; }
}

export async function probeFetch(fetcher = globalThis.fetch, now = () => performance.now()) {
  const start = now();
  try {
    // Same URL, native fetch receiver and redirect policy as the production provider.
    const response = await fetcher.call(globalThis, INFO_URL, {
      redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const body = await boundedResponse(response);
    return { ok: response.ok && body.response_shape === 'json', connected: true,
      http_status: response.status, elapsed_ms: elapsed(start, now), ...body };
  } catch (error) {
    return { ok: false, connected: false, elapsed_ms: elapsed(start, now), error: summarizeError(error) };
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('probe timed out'), {name:'TimeoutError'})), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

export async function probeSocket(connectFn, secureTransport, now = () => performance.now()) {
  const start = now();
  let socket;
  try {
    socket = connectFn({ hostname: HOST, port: PORT }, { secureTransport });
    // Sockets may reject closed after cancellation; observe it to avoid unhandled rejection.
    void socket.closed?.catch(() => {});
    await withTimeout(socket.opened, TIMEOUT_MS);
    return { ok: true, elapsed_ms: elapsed(start, now) };
  } catch (error) {
    return { ok: false, elapsed_ms: elapsed(start, now), error: summarizeError(error) };
  } finally {
    try { socket?.close(); } catch {}
  }
}

export function interpret({ fetch, tcp, tls }) {
  if (fetch.ok) return 'ROD HTTPS fetch works from this Cloudflare Worker. An earlier failure may be transient or specific to the game Worker deployment.';
  if (fetch.connected) return 'Network connection reached an HTTP server. Examine HTTP status and response shape; this is not a TCP connection failure.';
  if (tcp.ok && tls.ok) return 'TCP and TLS connect, but native fetch fails. Investigate Workers fetch handling, custom-port routing and HTTP-level behavior.';
  if (tcp.ok && !tls.ok) return 'TCP succeeds but TLS fails. Inspect certificate chain, SNI, HTTPS service and TLS configuration.';
  if (!tcp.ok && !tls.ok) return 'Both socket probes failed. DNS, routing, firewall, Cloudflare socket policy and port access remain possible; read the error categories.';
  return 'Probes disagree or are inconclusive. Interpret their error details individually.';
}

export async function runProbe({ fetcher = globalThis.fetch, connectFn, now = () => performance.now() } = {}) {
  if (typeof connectFn !== 'function') throw new TypeError('Cloudflare TCP connect() is required');
  // Deliberately sequential: only three bounded outbound operations, no retries.
  const fetch = await probeFetch(fetcher, now);
  const tcp = await probeSocket(connectFn, 'off', now);
  const tls = await probeSocket(connectFn, 'on', now);
  return { target: INFO_URL, read_only: true, fetch, tcp, tls, interpretation: interpret({ fetch, tcp, tls }),
    note: 'Socket failure alone does not prove DNS/TLS cause: Cloudflare restricts TCP sockets to certain destinations.' };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/probe' || url.search)
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    try {
      const { connect } = await import('cloudflare:sockets');
      const result = await runProbe({ connectFn: connect });
      return Response.json(result, { headers: { 'cache-control': 'no-store', 'x-content-type-options':'nosniff' } });
    } catch (error) {
      return Response.json({ diagnostic_failed: true, error: summarizeError(error) },
        { status: 500, headers: { 'cache-control':'no-store' } });
    }
  }
};
