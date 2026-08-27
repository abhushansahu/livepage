const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "si",
  "ref",
  "ref_src",
  "ref_url",
  "spm",
  "vero_id",
  "yclid"
]);

export function canonicalizeUrl(raw) {
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return String(raw).split("#")[0];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return url.toString();
  }
  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
  const kept = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path || "/";
  return url.toString();
}

export function pageIdFromUrl(canonicalUrl) {
  return `p_${simpleHash(canonicalUrl)}`;
}

export function hostnameOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function simpleHash(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
