import { handleRelayRequest } from './relay.js';
export { handleApi } from './relay.js';

export default {
  /** Forward API requests in-process; Cloudflare alone owns the static asset binding. */
  fetch(request,env) {
    if(new URL(request.url).pathname.startsWith('/api/'))return handleRelayRequest(request,env);
    return env.ASSETS.fetch(request);
  }
};
