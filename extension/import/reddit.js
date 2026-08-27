import { uniqueItems } from "./normalize.js";

export function itemsFromRedditListing(json, listUrl = "https://www.reddit.com/saved") {
  const children = json?.data?.children || json?.children || [];
  const items = [];
  for (const child of children) {
    const data = child?.data || child;
    if (!data) continue;
    const permalink = data.permalink
      ? `https://www.reddit.com${data.permalink}`
      : "";
    const dest = data.is_self || !data.url ? permalink : data.url;
    const url = dest || permalink;
    if (!url) continue;
    const excerpt = String(data.selftext || data.title || "").slice(0, 280);
    items.push({
      url,
      title: data.title || url,
      excerpt,
      author: data.subreddit ? `r/${data.subreddit}` : data.author || "",
      source: "reddit",
      kind: "saved",
      externalId: data.id || url,
      listUrl
    });
  }
  return uniqueItems(items);
}

export function harvestRedditDom(doc, pageUrl) {
  const items = [];
  const posts = doc.querySelectorAll(
    "shreddit-post, [data-testid='post-container'], .thing.link, article"
  );
  for (const post of posts) {
    const permalink =
      post.getAttribute?.("permalink") ||
      post.querySelector?.("a[data-click-id='comments'], a.comments, a[href*='/comments/']")
        ?.href ||
      "";
    const titleEl = post.querySelector?.(
      "a[slot='title'], a.title, [slot='title'], h3, a[data-click-id='body']"
    );
    const title = (titleEl?.textContent || post.getAttribute?.("post-title") || "").trim();
    const outbound =
      post.getAttribute?.("content-href") ||
      post.querySelector?.("a.title, a[data-testid='outbound-link']")?.href ||
      permalink;
    if (!outbound && !permalink) continue;
    const sub =
      post.getAttribute?.("subreddit-prefixed-name") ||
      post.querySelector?.("[data-testid='subreddit-name'], .subreddit")?.textContent ||
      "";
    items.push({
      url: outbound || permalink,
      title: title || outbound || permalink,
      excerpt: title,
      author: String(sub).trim(),
      source: "reddit",
      kind: "saved",
      listUrl: pageUrl
    });
  }
  return uniqueItems(items);
}
