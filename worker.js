import { handleRelayRequest,handleScheduled } from './relay.js';
import rodProbe from './tests/rod-transport-probe.worker.js';
export { handleApi } from './relay.js';

export default {
  /** Forward API requests in-process; Cloudflare alone owns the static asset binding. */
  fetch(request,env,ctx) {
    const pathname=new URL(request.url).pathname;
    // Temporary, fixed-target, read-only Cloudflare edge transport diagnostic.
    // /probe never reads Worker secrets, Supabase or the transaction publisher.
    if(pathname==='/probe')return rodProbe.fetch(request);
    if(pathname.startsWith('/api/'))return handleRelayRequest(request,env,ctx);
    return env.ASSETS.fetch(request);
  },
  /** SQL job fencing and the signing barrier make duplicate cron delivery safe. */
  scheduled(controller,env,ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};
