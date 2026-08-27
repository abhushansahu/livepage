import { hasOpened, needsReview, progressOf } from "../shared/progress.js";
import { sourceLabel } from "../shared/source-meta.js";

const DAY = 24 * 60 * 60 * 1000;

export function observeTrail(pages = [], events = [], now = Date.now()) {
  const active = pages.filter((p) => p.readState !== "released");
  const unopened = active.filter((p) => p.importMeta && !hasOpened(p));
  const mid = active.filter((p) => {
    const n = progressOf(p);
    return n > 8 && n < 90;
  });
  const finished = active.filter((p) => progressOf(p) >= 90);
  const awaiting = active.filter(needsReview);
  const bySource = {};
  for (const page of active) {
    const source = page.importMeta?.source || "live";
    const bucket = bySource[source] || emptySource();
    bucket.saved += 1;
    if (!hasOpened(page) && page.importMeta) bucket.unopened += 1;
    if (hasOpened(page)) bucket.opened += 1;
    if (progressOf(page) >= 90) bucket.finished += 1;
    bucket.scrollSum += progressOf(page);
    bucket.pages.push(page);
    bySource[source] = bucket;
  }
  for (const bucket of Object.values(bySource)) {
    bucket.avgScroll = bucket.saved ? Math.round(bucket.scrollSum / bucket.saved) : 0;
    bucket.openRate = bucket.saved ? bucket.opened / bucket.saved : 0;
  }

  const week = events.filter((e) => now - (e.at || 0) < 7 * DAY);
  const snoozes = week.filter((e) => e.kind === "snooze").length;
  const opens = week.filter((e) => e.kind === "open" || e.kind === "tweet_act").length;
  const likes = week.filter((e) => e.kind === "tweet_like");
  const conversions = events.filter((e) => e.kind === "conversion");

  const oldestUnopened = unopened
    .slice()
    .sort((a, b) => (a.importMeta?.importedAt || a.createdAt || 0) - (b.importMeta?.importedAt || b.createdAt || 0))[0];
  const deepestMid = mid.slice().sort((a, b) => progressOf(b) - progressOf(a))[0];
  const nearestHalf = mid
    .slice()
    .sort((a, b) => Math.abs(progressOf(a) - 50) - Math.abs(progressOf(b) - 50))[0];

  const sourcesRanked = Object.entries(bySource)
    .filter(([k]) => k !== "live")
    .sort((a, b) => a[1].openRate - b[1].openRate);

  return {
    now,
    total: active.length,
    unopened,
    mid,
    finished,
    awaiting,
    bySource,
    finishRate: active.length ? finished.length / active.length : 0,
    snoozes,
    opens,
    likes,
    conversions,
    oldestUnopened,
    deepestMid,
    nearestHalf,
    worstSource: sourcesRanked[0] || null,
    bestSource: sourcesRanked[sourcesRanked.length - 1] || null,
    hour: new Date(now).getHours()
  };
}

function emptySource() {
  return { saved: 0, unopened: 0, opened: 0, finished: 0, scrollSum: 0, avgScroll: 0, openRate: 0, pages: [] };
}

export function clipTitle(page, n = 52) {
  const s = String(page?.title || page?.url || "this page");
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export { sourceLabel };
