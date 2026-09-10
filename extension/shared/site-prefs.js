import { hostnameOf } from "./url.js";

/**
 * Things you have turned off for one site and left on everywhere else.
 *
 * A global switch is the wrong grain for a surface that is welcome on an essay
 * and in the way on a documentation site you read every day. Muting is by
 * host, sticks until you turn it back on, and says nothing about anywhere
 * else.
 */

/**
 * Every surface that can be silenced on one site, and the settings key its
 * host list lives under.
 *
 * Kept as a table rather than a function per surface, because the second one
 * of these is where a copied file starts drifting from the first — the marks
 * would remember a site and the minimap would not, for no reason a reader
 * could see.
 */
export const SITE_SURFACES = {
  symbols: "symbolsOffHosts",
  markup: "markupOffHosts",
  minimap: "minimapOffHosts"
};

export function siteKey(url) {
  return hostnameOf(url);
}

/** Whether this surface is one you have turned off for this site. */
export function mutedHere(settings, url, surface) {
  const key = SITE_SURFACES[surface];
  const host = siteKey(url);
  if (!key || !host) return false;
  return (settings?.[key] || []).includes(host);
}

/**
 * Returns what this site's list becomes and what it now means here, along with
 * the patch to save. Pure, so the decision can be tested without a page or a
 * settings store.
 */
export function toggleSiteSurface(settings, url, surface) {
  const key = SITE_SURFACES[surface];
  const host = siteKey(url);
  const current = (key && settings?.[key]) || [];
  if (!key || !host) return { surface, host: "", muted: false, hosts: current, patch: {} };
  const muted = current.includes(host);
  const hosts = muted ? current.filter((item) => item !== host) : [...current, host];
  return {
    surface,
    host,
    // Muted before means this turns them back on.
    muted: !muted,
    hosts,
    patch: { [key]: hosts }
  };
}

export function symbolsMutedHere(settings, url) {
  return mutedHere(settings, url, "symbols");
}

export function toggleSymbolsForSite(settings, url) {
  const next = toggleSiteSurface(settings, url, "symbols");
  return { host: next.host, muted: next.muted, symbolsOffHosts: next.hosts };
}
