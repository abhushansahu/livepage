import { isWaiting, needsReview, progressOf, progressLabel, reviewItems, hasOpened } from "./progress.js";
import { composeLocalTweets, weaveFeed } from "../feed/local-tweets.js";

const DAY = 24 * 60 * 60 * 1000;

export function isSnoozed(page, now = Date.now()) {
  return Number(page?.snoozedUntil || 0) > now;
}

export { sourceLabel, sourceGlyph } from "./source-meta.js";
export { hasOpened } from "./progress.js";

export function reasonFor(page, extra = {}, now = Date.now()) {
  if (extra.kind === "review") {
    return "Your last turn is still waiting. The thread is still warm.";
  }
  const days = Math.max(0, Math.floor((now - (page.importMeta?.importedAt || page.createdAt || now)) / DAY));
  const wait = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  if (page.importMeta && !hasOpened(page)) {
    if (page.importMeta.source === "youtube") {
      return `Watch Later · parked ${wait} and never pressed play.`;
    }
    if (page.importMeta.source === "twitter") {
      return `Bookmarked on X ${wait} and never went back.`;
    }
    if (page.importMeta.source === "reddit") {
      return `Saved on Reddit ${wait} — still sitting in /saved.`;
    }
    if (page.importMeta.source === "rss") {
      return `From a tagged feed ${wait}${tagHint(page)} and still unread.`;
    }
    return `Saved ${wait} and never opened.`;
  }
  if (page.bookmarked && !hasOpened(page)) {
    return `Bookmarked ${wait}${tagHint(page)} · never opened.`;
  }
  const p = progressOf(page);
  if (p > 8 && p < 90) {
    return `You stopped at ${p}%. Halfway is still a place.`;
  }
  if (page.bookmarked && isWaiting(page)) {
    return `Starred${tagHint(page)}, but the scroll never finished.`;
  }
  if (isWaiting(page)) {
    return `Still not read through · ${progressLabel(page)}.`;
  }
  return page.why || "On the trail.";
}

export function feedItems(pages, now = Date.now()) {
  const items = [];
  const reviews = reviewItems(pages).filter((r) => r.awaiting);
  const reviewPages = new Set(reviews.map((r) => r.page.id));

  for (const page of pages || []) {
    if (page.readState === "released" || isSnoozed(page, now)) continue;
    if (reviewPages.has(page.id)) continue;
    const score = scorePage(page, now);
    if (score < 12) continue;
    const kind = kindOf(page);
    items.push({
      id: `p:${page.id}`,
      kind,
      page,
      score,
      reason: reasonFor(page, { kind }, now)
    });
  }

  for (const review of reviews) {
    if (isSnoozed(review.page, now) || review.page.readState === "released") continue;
    items.push({
      id: `r:${review.page.id}:${review.thread?.id || "t"}`,
      kind: "review",
      page: review.page,
      review,
      score: 92 + Math.min(8, (now - (review.last?.createdAt || 0)) / DAY),
      reason: reasonFor(review.page, { kind: "review" }, now)
    });
  }

  items.sort((a, b) => b.score - a.score || (b.page.updatedAt || 0) - (a.page.updatedAt || 0));
  return diversify(items);
}

export function composeFeed(pages, { mind, events, now = Date.now() } = {}) {
  const pagesFeed = feedItems(pages, now);
  if (mind?.enabled === false) return pagesFeed;
  const tweets = composeLocalTweets(pages, mind, events, now);
  return weaveFeed(pagesFeed, tweets, 2);
}

function kindOf(page) {
  if (page.importMeta && !hasOpened(page)) return "stalled_save";
  const p = progressOf(page);
  if (p > 8 && p < 90) return "continue";
  if (page.importMeta) return "save";
  if (page.bookmarked) return "bookmark";
  return "nudge";
}

export function scorePage(page, now = Date.now()) {
  if (page.readState === "released" || isSnoozed(page, now)) return 0;
  const p = progressOf(page);
  const ageDays = Math.min(45, Math.floor((now - (page.importMeta?.importedAt || page.createdAt || now)) / DAY));
  let score = 0;
  if (needsReview(page)) score += 88;
  if (page.importMeta && !hasOpened(page)) score += 74 + Math.min(20, ageDays);
  if (page.bookmarked && !hasOpened(page)) score += 28 + Math.min(24, ageDays);
  if (p > 8 && p < 90) score += 68 + (30 - Math.abs(p - 45)) / 3;
  if (page.bookmarked && p < 90) score += 18;
  if (isWaiting(page) && !page.importMeta) score += 22;
  if (p >= 90 && !needsReview(page)) score -= 40;
  const idle = Math.min(21, Math.floor((now - (page.lastVisitedAt || page.createdAt || now)) / DAY));
  score += idle * 0.6;
  return score;
}

function tagHint(page) {
  const tags = (page.tags || []).slice(0, 3);
  if (!tags.length) return "";
  return ` · ${tags.map((tag) => `#${tag}`).join(" ")}`;
}

function diversify(items) {
  const out = [];
  const used = new Set();
  const buckets = new Map();
  for (const item of items) {
    const key = item.page.importMeta?.source || item.kind;
    const list = buckets.get(key) || [];
    list.push(item);
    buckets.set(key, list);
  }
  const keys = [...buckets.keys()];
  let added = true;
  while (added) {
    added = false;
    for (const key of keys) {
      const list = buckets.get(key);
      while (list.length) {
        const next = list.shift();
        if (used.has(next.id)) continue;
        used.add(next.id);
        out.push(next);
        added = true;
        break;
      }
    }
  }
  return out;
}
