import { uniqueItems } from "./normalize.js";

function absUrl(href, pageUrl) {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href || "";
  }
}

function isStatusUrl(href) {
  return /\/(?:i\/web\/)?status\/\d+/.test(href || "");
}

function isExternal(href) {
  try {
    const host = new URL(href).hostname.replace(/^www\./i, "");
    return !["x.com", "twitter.com", "t.co", "pic.twitter.com"].includes(host);
  } catch {
    return false;
  }
}

export function harvestTwitterDom(doc, pageUrl) {
  const items = [];
  const articles = doc.querySelectorAll('article[data-testid="tweet"], article');
  for (const article of articles) {
    const links = [...(article.querySelectorAll?.("a[href]") || [])].map((a) =>
      absUrl(a.getAttribute("href") || a.href, pageUrl)
    );
    const status = links.find(isStatusUrl);
    const external = links.find(isExternal);
    const text = (article.querySelector?.('[data-testid="tweetText"]')?.textContent || "").trim();
    const user = (article.querySelector?.('[data-testid="User-Name"]')?.textContent || "")
      .trim()
      .split("\n")[0];
    const url = external || status;
    if (!url) continue;
    items.push({
      url,
      title: text ? clip(text, 120) : url,
      excerpt: text,
      author: user,
      source: "twitter",
      kind: "bookmark",
      externalId: status || url,
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
    if (!isExternal(href) && source !== "hn") continue;
    if (source === "hn" && !/\/item\?id=/.test(href) && !isExternal(href)) continue;
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

function clip(text, n) {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}
