import { epoch, medianTime } from './profile.js';

/** Accept a new tip only when it extends the exact pinned header on a single,
 * contiguous, hash-linked canonical chain. An extension over ten blocks is
 * deferred instead of consuming an unbounded read budget. Before signing,
 * median-time week must also match the score's pinned epoch.
 *
 * fetchHeaders validates header hashes, merkle roots, heights and links.
 * This remains single-provider trust; it does not bypass fresh address reads.
 */
export async function tipExtends(api, pinned, observed, expectedEpoch = null) {
  if (observed.height === pinned.height) return observed.hash === pinned.hash;
  if (observed.height < pinned.height || observed.height - pinned.height > 10) return false;
  const low = expectedEpoch === null ? pinned.height : Math.max(0, observed.height - 10);
  const chain = await api.fetchHeaders(low, observed.height);
  if (chain[0]?.height !== low || chain.at(-1)?.hash !== observed.hash) return false;
  if (chain.find(row => row.height === pinned.height)?.hash !== pinned.hash) return false;
  return expectedEpoch === null ||
    epoch(medianTime(chain.slice(-11).map(row => row.time))) === expectedEpoch;
}
