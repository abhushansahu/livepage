/**
 * Deciding what is a PDF, and moving between the PDF's own URL and the URL of
 * the viewer showing it.
 *
 * The rule that matters here: **the source PDF URL is the identity**. The
 * viewer URL contains the extension id, which changes on every reinstall, so
 * a record keyed on it would be orphaned the first time the user reloads the
 * unpacked extension. Everything downstream — the page id, the vault export,
 * the dashboard — keeps seeing the arXiv URL, exactly as if the PDF had been
 * an article.
 */

export const VIEWER_PATH = "pdf/viewer.html";

/**
 * Whether a URL is worth offering to open in the viewer.
 *
 * Deliberately conservative, because this only ever *offers*. Chrome will not
 * tell us the Content-Type before we fetch, so a URL that serves a PDF from a
 * pathless endpoint is a miss — the popup button still works there, because it
 * does not consult this. What we must not do is claim `/pdf/reader` or
 * `report.pdfa` is a document.
 */
export function looksLikePdfUrl(url) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol) && parsed.protocol !== "file:") return false;
  return /\.pdf$/i.test(parsed.pathname);
}

/** The viewer URL for a PDF, given the extension's own base URL. */
export function viewerUrlFor(sourceUrl, base) {
  const root = base || runtimeViewerUrl();
  if (!root || !sourceUrl) return "";
  const url = new URL(root);
  url.searchParams.set("file", sourceUrl);
  return url.toString();
}

/**
 * The PDF a viewer URL is showing, or "" if this is not a viewer URL.
 *
 * Checks the path rather than the origin: the extension id differs between
 * this install and the one that wrote a bookmark, and the answer is the same
 * either way.
 */
export function sourceUrlFrom(viewerUrl) {
  if (!viewerUrl) return "";
  let parsed;
  try {
    parsed = new URL(viewerUrl);
  } catch {
    return "";
  }
  // The scheme has to be ours, or any site could publish a page at
  // /pdf/viewer.html and have us treat its query string as a document
  // identity. The *id* deliberately is not checked: it changes on every
  // reinstall, and a link saved before the last one names the same PDF.
  if (parsed.protocol !== "chrome-extension:") return "";
  if (parsed.pathname !== "/" + VIEWER_PATH) return "";
  return parsed.searchParams.get("file") || "";
}

/** True when this URL is one of our viewer pages, whoever installed it. */
export function isViewerUrl(url) {
  return Boolean(sourceUrlFrom(url));
}

/**
 * The page number a PDF link asked for, as in `paper.pdf#page=7`.
 *
 * Returns 0 when there is none, so the caller can tell "no request" from
 * "page 1" without a second argument.
 */
export function requestedPage(url) {
  if (!url) return 0;
  const hash = String(url).split("#")[1] || "";
  const match = /(?:^|&)page=(\d+)/.exec(hash);
  const page = match ? Number(match[1]) : 0;
  return Number.isFinite(page) && page > 0 ? page : 0;
}

function runtimeViewerUrl() {
  try {
    return globalThis.chrome?.runtime?.getURL?.(VIEWER_PATH) || "";
  } catch {
    return "";
  }
}
