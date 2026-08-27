import { observeTrail, clipTitle } from "./observe.js";
import { progressOf } from "../shared/progress.js";
import { sourceLabel } from "../shared/source-meta.js";

const DAY = 24 * 60 * 60 * 1000;

export function composeLocalTweets(pages, mind = {}, events = [], now = Date.now()) {
  const trail = observeTrail(pages, events, now);
  const candidates = [
    tweetGraveyard(trail),
    tweetOnePass(trail),
    tweetMidScroll(trail),
    tweetHalfway(trail),
    tweetReview(trail),
    tweetSnooze(trail),
    tweetSourceAffinity(trail),
    tweetFinishRate(trail),
    tweetConversion(trail, events),
    tweetHour(trail)
  ].filter(Boolean);

  return pickTweets(candidates, mind, now, 5);
}

export function weaveFeed(pageItems, tweets, every = 2) {
  const posts = pageItems || [];
  const notes = tweets || [];
  if (!notes.length) return posts.slice();
  const out = [];
  let ti = 0;
  if (notes[0]) out.push(notes[ti++]);
  for (let i = 0; i < posts.length; i += 1) {
    out.push(posts[i]);
    if ((i + 1) % every === 0 && notes[ti]) out.push(notes[ti++]);
  }
  while (ti < notes.length) out.push(notes[ti++]);
  return out;
}

function tweetGraveyard(trail) {
  const [source, bucket] = trail.worstSource || [];
  if (!bucket || bucket.unopened < 2) return null;
  const page = bucket.pages.find((p) => !progressOf(p)) || bucket.pages[0];
  const label = sourceLabel({ importMeta: { source } });
  return localTweet({
    signal: `graveyard_${source}`,
    page,
    baseScore: 86 + Math.min(10, bucket.unopened),
    text: `I have been watching the ${label} pile. ${bucket.unopened} saves, ${bucket.opened} actual opens. That is not a reading list — it is a museum of intended selves. One real pass. Start with “${clipTitle(page)}”.`,
    cta: "Open this one"
  });
}

function tweetOnePass(trail) {
  const page = trail.oldestUnopened;
  if (!page) return null;
  const days = Math.max(1, Math.floor((trail.now - (page.importMeta?.importedAt || page.createdAt)) / DAY));
  return localTweet({
    signal: "one_real_pass",
    page,
    baseScore: 80 + Math.min(12, days / 2),
    text: `${days} days in the graveyard: “${clipTitle(page)}”. You do not need to finish the pile. You need to scroll this one past 90%. That is the whole goal — a real pass, not another save.`,
    cta: "Give it a real pass"
  });
}

function tweetMidScroll(trail) {
  if (trail.mid.length < 1) return null;
  const page = trail.deepestMid;
  const p = progressOf(page);
  const extra = trail.mid.length > 1 ? ` ${trail.mid.length} pages are sitting mid-scroll.` : "";
  return localTweet({
    signal: "mid_scroll",
    page,
    baseScore: 78 + p / 10,
    text: `Halfway is your habitat. You left “${clipTitle(page)}” at ${p}%.${extra} The interesting part is rarely in the first third. Finish the scroll you already started — cheaper than opening a new tab.`,
    cta: "Continue the scroll"
  });
}

function tweetHalfway(trail) {
  const page = trail.nearestHalf;
  if (!page || page === trail.deepestMid) return null;
  const p = progressOf(page);
  if (Math.abs(p - 50) > 15) return null;
  return localTweet({
    signal: "halfway_place",
    page,
    baseScore: 72,
    text: `${p}% is a place, not a failure. “${clipTitle(page)}” still has a bottom. I will keep putting it here until the bar moves. That is not nagging. That is how trails work.`,
    cta: "Go back to the place"
  });
}

function tweetReview(trail) {
  const page = trail.awaiting[0];
  if (!page) return null;
  return localTweet({
    signal: "review_warm",
    page,
    baseScore: 90,
    text: `Your last voice on “${clipTitle(page)}” is still hanging in the margin. The page already knows you. Closing the thought is more reading than saving three new essays.`,
    cta: "Return to the thread"
  });
}

function tweetSnooze(trail) {
  if (trail.snoozes < 2 || trail.snoozes <= trail.opens) return null;
  const page = trail.oldestUnopened || trail.mid[0];
  if (!page) return null;
  return localTweet({
    signal: "snooze_pattern",
    page,
    baseScore: 70 + trail.snoozes,
    text: `You hit Not now ${trail.snoozes} times this week and opened ${trail.opens}. That is a rhythm, not a no. I will stop offering the long ones. Here is a short trail: “${clipTitle(page)}”.`,
    cta: "This one is short"
  });
}

function tweetSourceAffinity(trail) {
  const best = trail.bestSource;
  const worst = trail.worstSource;
  if (!best || !worst || best[0] === worst[0]) return null;
  if (best[1].opened < 1 || worst[1].unopened < 2) return null;
  const page = worst[1].pages.find((p) => !progressOf(p)) || worst[1].pages[0];
  return localTweet({
    signal: "source_affinity",
    page,
    baseScore: 74,
    text: `${sourceLabel({ importMeta: { source: best[0] } })} actually becomes reading for you (${Math.round(best[1].openRate * 100)}% opened). ${sourceLabel({ importMeta: { source: worst[0] } })} does not (${worst[1].unopened} still untouched). Trust the first. Or pick one from the second and break the pattern: “${clipTitle(page)}”.`,
    cta: "Break the pattern"
  });
}

function tweetFinishRate(trail) {
  if (trail.total < 4) return null;
  const pct = Math.round(trail.finishRate * 100);
  if (pct >= 40) return null;
  const page = trail.nearestHalf || trail.oldestUnopened || trail.mid[0];
  if (!page) return null;
  return localTweet({
    signal: "finish_rate",
    page,
    baseScore: 76 + (40 - pct) / 4,
    text: `${pct}% of the trail has been read through. Saving is the cheap dopamine. Scroll depth is the receipt. I am not counting streaks. I am asking for one finished page: “${clipTitle(page)}”.`,
    cta: "Read this through"
  });
}

function tweetConversion(trail, events) {
  const last = [...(events || [])].reverse().find((e) => e.kind === "conversion");
  if (!last || trail.now - last.at > 3 * DAY) return null;
  const page = trail.mid[0] || trail.unopened[0];
  if (!page) return null;
  return localTweet({
    signal: "conversion_praise",
    page,
    baseScore: 84,
    text: `Last time you listened, the bar actually moved. That is the loop I am trying to learn: observation → you open → scroll. Same move, new page: “${clipTitle(page)}”.`,
    cta: "Do it again"
  });
}

function tweetHour(trail) {
  if (trail.hour < 21 && trail.hour > 10) return null;
  const page = trail.mid[0] || trail.oldestUnopened;
  if (!page) return null;
  return localTweet({
    signal: "late_hour",
    page,
    baseScore: 60,
    text: `Late hours are when you save, not when you finish. If you have twelve minutes, “${clipTitle(page)}” is already open in your trail. Do not add another bookmark. Move the bar.`,
    cta: "Twelve minutes"
  });
}

function localTweet({ signal, page, text, cta, baseScore }) {
  return {
    id: `lt:${signal}:${page?.id || "none"}`,
    kind: "local_tweet",
    signal,
    page,
    pageId: page?.id || null,
    text,
    cta,
    baseScore,
    reason: "A local observation — learned from the trail, not a feed of news."
  };
}

export function pickTweets(candidates, mind = {}, now = Date.now(), limit = 4) {
  const signals = mind.signals || {};
  const scored = [];
  for (const tweet of candidates) {
    const mem = signals[tweet.signal] || {};
    if (mem.dismissedUntil && mem.dismissedUntil > now) continue;
    const likes = Number(mem.likes || 0);
    const dismisses = Number(mem.dismisses || 0);
    const conversions = Number(mem.conversions || 0);
    const lastShown = Number(mem.lastShown || 0);
    const hoursAgo = lastShown ? (now - lastShown) / (60 * 60 * 1000) : 99;
    const recency = hoursAgo < 6 ? 0.35 : hoursAgo < 18 ? 0.7 : 1;
    const score =
      tweet.baseScore *
      (1 + likes * 0.45 + conversions * 0.6) *
      (1 / (1 + dismisses * 0.8)) *
      recency;
    scored.push({ ...tweet, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function applyTweetReaction(mind, { signal, reaction, now = Date.now() }) {
  const next = {
    ...mind,
    signals: { ...(mind.signals || {}) }
  };
  const row = { ...(next.signals[signal] || { likes: 0, dismisses: 0, conversions: 0, lastShown: 0 }) };
  if (reaction === "like") row.likes = (row.likes || 0) + 1;
  if (reaction === "dismiss") {
    row.dismisses = (row.dismisses || 0) + 1;
    row.dismissedUntil = now + 5 * DAY;
  }
  if (reaction === "act") row.acts = (row.acts || 0) + 1;
  if (reaction === "shown") row.lastShown = now;
  if (reaction === "conversion") row.conversions = (row.conversions || 0) + 1;
  next.signals[signal] = row;
  if (reaction === "act") next.lastAct = { signal, at: now };
  return next;
}
