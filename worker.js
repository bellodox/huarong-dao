// Experiment only: inserts the Cloudflare Worker secret into the delivered HTML.
// This keeps the WIF out of the deployed source asset, NOT out of the browser.
const WIF_CONFIG_LINE = "const ROD_EXPERIMENT_ISSUER_WIF = '';";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !['/', '/index.html'].includes(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    // No configured secret: deliver the local-only game normally.
    // No WIF, no public score calls, no wallet creation.
    if (!env.ROD_EXPERIMENT_ISSUER_WIF || !String(env.ROD_EXPERIMENT_ISSUER_WIF).trim()) {
      return env.ASSETS.fetch(request);
    }

    const source = await env.ASSETS.fetch(
      new Request(new URL('/index.html', url), request)
    );
    if (!source.ok) return source;

    const html = await source.text();
    if (!html.includes(WIF_CONFIG_LINE)) {
      return new Response('ROD WIF configuration line not found in index.html', { status: 500 });
    }

    const configured = html.replace(
      WIF_CONFIG_LINE,
      `const ROD_EXPERIMENT_ISSUER_WIF = ${JSON.stringify(env.ROD_EXPERIMENT_ISSUER_WIF)};`
    );
    const headers = new Headers(source.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    headers.delete('ETag');
    headers.delete('Content-Length');
    return new Response(configured, { status: source.status, headers });
  }
};
