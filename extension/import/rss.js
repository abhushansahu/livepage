import { canonicalizeUrl } from "../shared/url.js";
import { mergeTags, normalizeTag, parseLooseTags } from "../shared/tags.js";
import { uniqueItems } from "./normalize.js";

const RSS_TYPES = /rss|atom|\+xml/i;

export function parseRssUrlInput(text) {
  const feeds = [];
  const seen = new Set();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const httpUrls = line.match(/https?:\/\/[^\s,;<>]+/gi) || [];
    const urls = httpUrls.map((url) => url.replace(/[.,;:]+$/, ""));
    if (!urls.length) {
      const token = line.split(/\s+/)[0];
      if (token && /[a-z0-9-]+\.[a-z]{2,}/i.test(token) && !token.startsWith("#")) {
        urls.push(/^https?:\/\//i.test(token) ? token : `https://${token}`);
      }
    }
    if (!urls.length) continue;
    const leftover = line
      .replace(/https?:\/\/[^\s,;<>]+/gi, " ")
      .replace(/^[^\s]+\.[^\s]+/, " ");
    const tags = parseLooseTags(leftover);
    for (const raw of urls) {
      let url = raw;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (seen.has(url)) continue;
      seen.add(url);
      feeds.push({ url, tags });
    }
  }
  return feeds;
}

export function detectFeeds(doc, pageUrl) {
  if (!doc) return [];
  if (looksLikeFeedDocument(doc, pageUrl)) {
    return [
      {
        url: canonicalizeUrl(pageUrl),
        title: textOf(doc.querySelector("title, channel > title")) || doc.title || "RSS"
      }
    ];
  }
  const out = [];
  const seen = new Set();
  const nodes = doc.querySelectorAll?.('link[rel~="alternate"], a[rel~="alternate"]') || [];
  for (const node of nodes) {
    const type = String(node.getAttribute?.("type") || "");
    const href = node.getAttribute?.("href") || node.href;
    if (!href) continue;
    if (type && !RSS_TYPES.test(type)) continue;
    if (!type && !looksLikeFeedHref(href)) continue;
    let url = "";
    try {
      url = canonicalizeUrl(new URL(href, pageUrl).href);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: node.getAttribute?.("title") || doc.title || "RSS"
    });
  }
  return out;
}

export function looksLikeFeedHref(href) {
  return /(\.rss|\.atom|\.xml|\/feed\/?|\/rss\/?|\/atom\/?)/i.test(String(href || ""));
}

export function looksLikeFeedDocument(doc, pageUrl) {
  const root = doc.documentElement?.localName || doc.documentElement?.tagName || "";
  if (/^(rss|feed|rdf)$/i.test(root)) return true;
  return looksLikeFeedHref(pageUrl);
}

export function parseRssXml(xml, feedUrl = "") {
  const text = String(xml || "");
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const title =
    decode(child(text, isAtom ? "feed" : "channel", "title")) || feedUrl || "RSS";
  const entries = isAtom
    ? collectBlocks(text, "entry")
    : collectBlocks(text, "item");
  const items = [];
  for (const block of entries) {
    const link = isAtom ? atomLink(block, feedUrl) : firstUrl(child(block, null, "link"), feedUrl);
    if (!link) continue;
    const itemTitle = decode(child(block, null, "title")) || link;
    const excerpt = decode(
      child(block, null, "description") ||
        child(block, null, "summary") ||
        child(block, null, "content")
    );
    const categories = collectSimple(block, "category").map((value) =>
      normalizeTag(stripAttrs(value))
    );
    items.push({
      url: canonicalizeUrl(link),
      title: itemTitle,
      excerpt: clip(stripTags(excerpt), 280),
      tags: mergeTags(categories),
      publishedAt: Date.parse(child(block, null, "pubDate") || child(block, null, "updated") || "") || 0
    });
  }
  return { title, items, kind: isAtom ? "atom" : "rss" };
}

export async function fetchRssFeed(url) {
  const href = canonicalizeUrl(url);
  const response = await fetch(href, { credentials: "omit" });
  if (!response.ok) {
    return { ok: false, url: href, status: `http ${response.status}`, items: [] };
  }
  const xml = await response.text();
  const parsed = parseRssXml(xml, href);
  return {
    ok: parsed.items.length > 0,
    url: href,
    title: parsed.title,
    status: parsed.items.length ? "ok" : "no-items",
    items: parsed.items,
    kind: parsed.kind
  };
}

export function rssItemsForFeed(feed, fetched) {
  return uniqueItems(
    (fetched.items || []).map((item) => ({
      url: item.url,
      title: item.title,
      excerpt: item.excerpt,
      source: "rss",
      kind: "rss",
      author: feed.title || fetched.title || "",
      tags: mergeTags(["rss"], feed.tags, item.tags),
      bookmarked: false,
      why: `From RSS · ${feed.title || fetched.title || feed.url}`,
      importedAt: item.publishedAt || Date.now(),
      importMeta: {
        source: "rss",
        kind: "rss",
        author: feed.title || fetched.title || "",
        feedId: feed.id,
        feedUrl: feed.url,
        importedAt: item.publishedAt || Date.now(),
        lastSyncedAt: Date.now()
      }
    }))
  );
}

export async function syncRssFeeds({ settings, importItems, feedId } = {}) {
  const feeds = (settings?.rssFeeds || []).filter((feed) => {
    if (feed.enabled === false) return false;
    if (feedId && feed.id !== feedId) return false;
    return Boolean(feed.url);
  });
  const reports = [];
  const collected = [];
  for (const feed of feeds) {
    try {
      const fetched = await fetchRssFeed(feed.url);
      const items = rssItemsForFeed(feed, fetched);
      reports.push({
        source: "rss",
        feedId: feed.id,
        ok: fetched.ok,
        status: fetched.status,
        items: items.length
      });
      collected.push(...items);
    } catch (error) {
      reports.push({
        source: "rss",
        feedId: feed.id,
        ok: false,
        status: error.message || String(error),
        items: 0
      });
    }
  }
  let imported = 0;
  let updated = 0;
  if (collected.length && importItems) {
    const result = await importItems(collected);
    imported = result?.imported || 0;
    updated = result?.updated || 0;
  }
  return {
    ok: true,
    reports,
    imported,
    updated,
    itemCount: collected.length,
    items: collected
  };
}

function collectBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi");
  return xml.match(re) || [];
}

function collectSimple(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>|<${tag}\\s+[^>]*\\/>`, "gi");
  const out = [];
  let match;
  while ((match = re.exec(xml))) {
    out.push(match[1] || match[0]);
  }
  return out;
}

function child(xml, scope, tag) {
  const source = scope ? scoped(xml, scope) : xml;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = source.match(re);
  return match ? match[1] : "";
}

function scoped(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "i");
  const match = xml.match(re);
  return match ? match[0] : xml;
}

function atomLink(block, feedUrl) {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*>/i);
  const any = block.match(/<link[^>]*>/i);
  const tag = (alt || any || [""])[0];
  const href = tag.match(/href=["']([^"']+)["']/i);
  if (href) return absUrl(decode(href[1]), feedUrl);
  return firstUrl(child(block, null, "link"), feedUrl);
}

function firstUrl(value, base) {
  const raw = stripTags(decode(value)).trim();
  if (!raw) return "";
  return absUrl(raw, base);
}

function absUrl(value, base) {
  try {
    return new URL(value, base || undefined).href;
  } catch {
    return value;
  }
}

function decode(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function stripAttrs(value) {
  const term = String(value || "").match(/term=["']([^"']+)["']/i);
  if (term) return decode(term[1]);
  return stripTags(decode(value));
}

function textOf(node) {
  return node?.textContent?.trim() || "";
}

function clip(text, n) {
  const s = String(text || "");
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
