import { uniqueItems } from "./normalize.js";
import { collectByKey } from "./youtube.js";

function absUrl(href, pageUrl) {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href || "";
  }
}

export function isStatusUrl(href) {
  return /\/(?:i\/web\/|i\/)?status\/\d+/.test(href || "");
}

function canonicalStatusUrl(href, pageUrl) {
  try {
    const url = new URL(href, pageUrl);
    const match = url.pathname.match(/^(?:\/i\/web)?\/[^/]+\/status\/(\d+)/) || url.pathname.match(/^\/i\/status\/(\d+)/);
    if (!match) return "";
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const origin = host.endsWith("twitter.com") || host === "x.com" || host.endsWith(".x.com")
      ? "https://x.com"
      : `${url.protocol}//${url.host}`;
    const user = url.pathname.match(/\/([^/]+)\/status\//)?.[1] || "i";
    return `${origin}/${user}/status/${match[1]}`;
  } catch {
    return "";
  }
}

function articleOf(node) {
  return {
    querySelectorAll: (sel) => node.querySelectorAll?.(sel) || [],
    querySelector: (sel) => node.querySelector?.(sel) || null
  };
}

export function harvestTwitterDom(doc, pageUrl) {
  const articles = [
    ...(doc.querySelectorAll?.('article[data-testid="tweet"], article, div[data-testid="cellInnerDiv"]') || [])
  ];
  const items = [];
  for (const node of articles) {
    const article = typeof node.querySelectorAll === "function" ? node : articleOf(node);
    const item = itemFromTweetNode(article, pageUrl);
    if (item) items.push(item);
  }
  const unique = uniqueItems(items);
  if (unique.length) return unique;
  return harvestTwitterStatusLinks(doc, pageUrl);
}

function itemFromTweetNode(article, pageUrl) {
  const links = [...(article.querySelectorAll?.("a[href]") || [])].map((a) =>
    absUrl(a.getAttribute?.("href") || a.href, pageUrl)
  );
  const status = links.map((href) => canonicalStatusUrl(href, pageUrl)).find(Boolean);
  const text = (
    article.querySelector?.('[data-testid="tweetText"]')?.textContent ||
    article.querySelector?.("[lang]")?.textContent ||
    ""
  ).trim();
  const user = (article.querySelector?.('[data-testid="User-Name"]')?.textContent || "")
    .trim()
    .split("\n")[0];
  if (!status) return null;
  return {
    url: status,
    title: text ? clip(text, 120) : status,
    excerpt: text,
    author: user,
    source: "twitter",
    kind: "saved",
    externalId: status,
    listUrl: pageUrl
  };
}

export function harvestTwitterStatusLinks(doc, pageUrl) {
  const items = [];
  const anchors = doc.querySelectorAll?.('a[href*="/status/"]') || [];
  for (const a of anchors) {
    const href = absUrl(a.getAttribute?.("href") || a.href, pageUrl);
    const status = canonicalStatusUrl(href, pageUrl);
    if (!status) continue;
    const text = (a.textContent || "").trim();
    items.push({
      url: status,
      title: text && text.length > 8 ? clip(text, 120) : status,
      excerpt: text,
      author: "",
      source: "twitter",
      kind: "saved",
      externalId: status,
      listUrl: pageUrl
    });
  }
  return uniqueItems(items);
}

export function harvestGenericList(doc, pageUrl, source, kind) {
  const items = [];
  const anchors = doc.querySelectorAll("a[href]");
  for (const a of anchors) {
    const href = absUrl(a.getAttribute("href") || a.href, pageUrl);
    let host = "";
    try {
      host = new URL(href).hostname.replace(/^www\./i, "");
    } catch {
      continue;
    }
    const isX = ["x.com", "twitter.com", "t.co", "pic.twitter.com"].includes(host);
    if (isX && source !== "hn") continue;
    if (source === "hn" && !/\/item\?id=/.test(href) && isX) continue;
    const title = (a.textContent || "").trim();
    if (title.length < 8) continue;
    items.push({
      url: href,
      title,
      excerpt: title,
      source,
      kind,
      listUrl: pageUrl
    });
  }
  return uniqueItems(items);
}

export function itemsFromTwitterGraphql(payloads) {
  const items = [];
  for (const payload of payloads || []) {
    const tweets = [
      ...collectByKey(payload, "tweet_results"),
      ...collectByKey(payload, "tweetResult")
    ];
    for (const wrapper of tweets) {
      const tweet = wrapper?.result?.tweet || wrapper?.result || wrapper?.tweet || wrapper;
      const legacy = tweet?.legacy || tweet?.tweet?.legacy;
      const restId = String(tweet?.rest_id || legacy?.id_str || "");
      if (!legacy?.full_text || !restId) continue;
      const user =
        tweet?.core?.user_results?.result?.legacy ||
        tweet?.core?.user_result?.result?.legacy ||
        {};
      const screen = user.screen_name || "i";
      items.push({
        url: `https://x.com/${screen}/status/${restId}`,
        title: clip(legacy.full_text, 120),
        excerpt: legacy.full_text,
        author: user.name || screen,
        source: "twitter",
        kind: "saved",
        externalId: restId,
        listUrl: "https://x.com/i/bookmarks"
      });
    }
  }
  return uniqueItems(items);
}

/**
 * Self-contained: parse payloads already captured on the page.
 * Chrome serialize this into the tab — do not close over module scope.
 */
export function scrapeCapturedTwitterBookmarksFromPage() {
  const payloads = globalThis.__LP_X_BOOKMARKS || [];
  const items = [];
  const seen = new Set();
  function walk(node, visit) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visit);
      return;
    }
    if (node.tweet_results) visit(node.tweet_results);
    if (node.tweetResult) visit(node.tweetResult);
    for (const value of Object.values(node)) walk(value, visit);
  }
  function clipText(text, n) {
    const value = String(text || "");
    return value.length <= n ? value : `${value.slice(0, n - 1)}…`;
  }
  for (const payload of payloads) {
    walk(payload, (wrapper) => {
      const tweet = wrapper?.result?.tweet || wrapper?.result || wrapper?.tweet || wrapper;
      const legacy = tweet?.legacy || tweet?.tweet?.legacy;
      const restId = String(tweet?.rest_id || legacy?.id_str || "");
      const text = legacy?.full_text || tweet?.note_tweet?.note_tweet_results?.result?.text || "";
      if (!text || !restId) return;
      const user =
        tweet?.core?.user_results?.result?.legacy ||
        tweet?.core?.user_result?.result?.legacy ||
        {};
      const screen = user.screen_name || "i";
      const url = `https://x.com/${screen}/status/${restId}`;
      if (seen.has(url)) return;
      seen.add(url);
      items.push({
        url,
        title: clipText(text, 120),
        excerpt: text,
        author: user.name || screen,
        source: "twitter",
        kind: "saved",
        externalId: restId,
        listUrl: "https://x.com/i/bookmarks"
      });
    });
  }
  return items;
}

/**
 * Self-contained: Chrome serializes this into the tab via executeScript.
 * Do not close over module scope.
 */
export function scrapeTwitterBookmarksFromPage() {
  const pageUrl = String(globalThis.location?.href || "");
  function abs(href) {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return href || "";
    }
  }
  function statusUrl(href) {
    try {
      const url = new URL(href, pageUrl);
      const match =
        url.pathname.match(/^(?:\/i\/web)?\/[^/]+\/status\/(\d+)/) ||
        url.pathname.match(/^\/i\/status\/(\d+)/);
      if (!match) return "";
      const user = url.pathname.match(/\/([^/]+)\/status\//)?.[1] || "i";
      return `https://x.com/${user}/status/${match[1]}`;
    } catch {
      return "";
    }
  }
  function clipText(text, n) {
    return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
  }
  function queryDeep(root, selector) {
    const out = [];
    if (!root) return out;
    if (root.querySelectorAll) out.push(...root.querySelectorAll(selector));
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) out.push(...queryDeep(el.shadowRoot, selector));
    }
    return out;
  }
  const items = [];
  const seen = new Set();
  const articles = queryDeep(
    document,
    'article[data-testid="tweet"], article, div[data-testid="cellInnerDiv"]'
  );
  for (const article of articles) {
    const links = [...article.querySelectorAll("a[href]")].map((a) => abs(a.getAttribute("href") || a.href));
    const status = links.map((href) => statusUrl(href)).find(Boolean);
    if (!status || seen.has(status)) continue;
    seen.add(status);
    const text = (
      article.querySelector('[data-testid="tweetText"]')?.textContent ||
      article.querySelector("[lang]")?.textContent ||
      ""
    ).trim();
    const user = (article.querySelector('[data-testid="User-Name"]')?.textContent || "")
      .trim()
      .split("\n")[0];
    items.push({
      url: status,
      title: text ? clipText(text, 120) : status,
      excerpt: text,
      author: user,
      source: "twitter",
      kind: "saved",
      externalId: status,
      listUrl: pageUrl
    });
  }
  if (items.length) return items;
  for (const a of queryDeep(document, 'a[href*="/status/"]')) {
    const status = statusUrl(abs(a.getAttribute("href") || a.href));
    if (!status || seen.has(status)) continue;
    seen.add(status);
    const text = (a.textContent || "").trim();
    items.push({
      url: status,
      title: text && text.length > 8 ? clipText(text, 120) : status,
      excerpt: text,
      author: "",
      source: "twitter",
      kind: "saved",
      externalId: status,
      listUrl: pageUrl
    });
  }
  return items;
}

export async function prepareTwitterBookmarksPage() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 8; i += 1) {
    const count = document.querySelectorAll('article[data-testid="tweet"], a[href*="/status/"]').length;
    if (count > 0 && i >= 2) break;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(450);
  }
  window.scrollTo(0, 0);
  await sleep(250);
  return document.querySelectorAll('article, a[href*="/status/"]').length;
}

function clip(text, n) {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}
