import { hostnameOf } from "./url.js";

/**
 * Things you have turned off for one site and left on everywhere else.
 *
 * A global switch is the wrong grain for a surface that is welcome on an essay
 * and in the way on a documentation site you read every day. Muting is by
 * host, sticks until you turn it back on, and says nothing about anywhere
 * else.
 */

export function siteKey(url) {
  return hostnameOf(url);
}

export function symbolsMutedHere(settings, url) {
  const host = siteKey(url);
  if (!host) return false;
  return (settings?.symbolsOffHosts || []).includes(host);
}

/**
 * Returns the next host list and what it now means for this site. Pure, so
 * the decision can be tested without a page or a settings store.
 */
export function toggleSymbolsForSite(settings, url) {
  const host = siteKey(url);
  const current = settings?.symbolsOffHosts || [];
  if (!host) return { host: "", muted: false, symbolsOffHosts: current };
  const muted = current.includes(host);
  return {
    host,
    // Muted before means this turns them back on.
    muted: !muted,
    symbolsOffHosts: muted ? current.filter((item) => item !== host) : [...current, host]
  };
}
