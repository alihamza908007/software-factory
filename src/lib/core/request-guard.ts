/**
 * Request guards shared by the middleware and unit tests.
 *
 * The factory is a local-first app: by default it trusts `127.0.0.1`. These
 * helpers add two cheap protections that do not change that default:
 *  - reject cross-site mutations (a random website must not be able to POST to
 *    localhost and start runs or edit files),
 *  - compare an optional bearer token without early-exit timing leaks.
 */

export function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // non-browser clients (curl, scripts) have no Origin
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isCrossSite(fetchSite: string | null): boolean {
  return fetchSite === "cross-site";
}

export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
