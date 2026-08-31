import { canonicalizeUrl } from "../shared/url.js";
import { mergeTags } from "../shared/tags.js";

export function normalizeItem(partial = {}) {
  const url = canonicalizeUrl(partial.url || "");
  if (!url || !/^https?:/i.test(url)) return null;
  const source = partial.source || partial.importMeta?.source || "web";
  const kind = partial.kind || partial.importMeta?.kind || "saved";
  const title = String(partial.title || url).trim();
  const excerpt = String(partial.excerpt || "").trim();
  const author = String(partial.author || partial.importMeta?.author || "").trim();
  const bookmarked = Boolean(partial.bookmarked);
  return {
    url,
    title,
    excerpt,
    author,
    bookmarked,
    tags: mergeTags(partial.tags),
    why: partial.why || whyFor(source, kind, author),
    importMeta: {
      source,
      kind,
      author,
      externalId: String(partial.externalId || partial.importMeta?.externalId || url),
      listUrl: partial.listUrl || partial.importMeta?.listUrl || "",
      feedId: partial.importMeta?.feedId || "",
      feedUrl: partial.importMeta?.feedUrl || "",
      importedAt: partial.importedAt || partial.importMeta?.importedAt || Date.now(),
      lastSyncedAt: Date.now()
    }
  };
}

export function whyFor(source, kind, author) {
  const who = author ? ` · ${author}` : "";
  if (source === "twitter") return `Bookmarked on X${who}`;
  if (source === "reddit") return `Saved on Reddit${who}`;
  if (source === "youtube") return `Watch later on YouTube${who}`;
  if (source === "pocket") return `Saved in Pocket${who}`;
  if (source === "hn") return `Favorited on HN${who}`;
  if (source === "rss") return `From RSS${who}`;
  return `Saved from ${source}${who}`;
}

export function uniqueItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const next = normalizeItem(item);
    if (!next || seen.has(next.url)) continue;
    seen.add(next.url);
    out.push(next);
  }
  return out;
}
