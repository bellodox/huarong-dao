import { handleRelayRequest,handleScheduled } from './relay.js';
export { handleApi } from './relay.js';

export default {
  /** Forward API requests in-process; Cloudflare alone owns the static asset binding. */
  fetch(request,env,ctx) {
    if(new URL(request.url).pathname.startsWith('/api/'))return handleRelayRequest(request,env,ctx);
    return env.ASSETS.fetch(request);
  },
  /** SQL job fencing and the signing barrier make duplicate cron delivery safe. */
  scheduled(controller,env,ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};
