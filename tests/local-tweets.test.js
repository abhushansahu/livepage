import assert from "node:assert/strict";
import test from "node:test";
import { composeLocalTweets, pickTweets, applyTweetReaction, weaveFeed } from "../extension/feed/local-tweets.js";
import { composeFeed } from "../extension/shared/feed.js";

function page(partial) {
  return {
    id: partial.id,
    title: partial.title,
    url: partial.url || "https://example.com/" + partial.id,
    createdAt: partial.createdAt || Date.now() - 10 * 86400000,
    lastVisitedAt: partial.lastVisitedAt ?? 0,
    openedAt: partial.openedAt ?? null,
    bookmarked: true,
    readState: partial.readState || "unread",
    importMeta: partial.importMeta,
    progress: { maxPercent: partial.percent ?? 0 },
    threads: partial.threads || []
  };
}

test("local tweets notice a YouTube graveyard and ask for one real pass", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");
  const pages = [
    page({
      id: "yt1",
      title: "How to remember what you read",
      importMeta: { source: "youtube", importedAt: now - 14 * 86400000 }
    }),
    page({
      id: "yt2",
      title: "The case against finishing",
      importMeta: { source: "youtube", importedAt: now - 3 * 86400000 }
    }),
    page({
      id: "essay",
      title: "Live page",
      percent: 42,
      openedAt: now - 3600000,
      lastVisitedAt: now - 3600000,
      readState: "in_progress"
    })
  ];
  const tweets = composeLocalTweets(pages, {}, [], now);
  assert.ok(tweets.length >= 1);
  assert.ok(tweets.some((t) => /Watch Later|YouTube|real pass|mid-scroll|42%/i.test(t.text)));
  assert.ok(tweets.every((t) => t.kind === "local_tweet" && t.cta));
});

test("dismissed observations stay out of the feed for a few days", () => {
  const tweet = {
    id: "lt:graveyard_youtube:yt1",
    signal: "graveyard_youtube",
    baseScore: 90,
    text: "x",
    kind: "local_tweet"
  };
  const mind = applyTweetReaction({ signals: {} }, { signal: "graveyard_youtube", reaction: "dismiss" });
  const picked = pickTweets([tweet], mind, Date.now(), 4);
  assert.equal(picked.length, 0);
});

test("liked observations outrank ignored ones", () => {
  const now = Date.now();
  const a = { id: "a", signal: "graveyard_youtube", baseScore: 80, kind: "local_tweet" };
  const b = { id: "b", signal: "mid_scroll", baseScore: 80, kind: "local_tweet" };
  let mind = applyTweetReaction({ signals: {} }, { signal: "mid_scroll", reaction: "like", now });
  mind = applyTweetReaction(mind, { signal: "mid_scroll", reaction: "like", now });
  const picked = pickTweets([a, b], mind, now, 2);
  assert.equal(picked[0].signal, "mid_scroll");
});

test("local tweets weave into the page feed instead of replacing it", () => {
  const posts = [{ id: "p:1", kind: "nudge", page: { id: "1" } }, { id: "p:2", kind: "nudge", page: { id: "2" } }];
  const tweets = [{ id: "lt:a", kind: "local_tweet" }, { id: "lt:b", kind: "local_tweet" }];
  const feed = weaveFeed(posts, tweets, 2);
  assert.equal(feed[0].kind, "local_tweet");
  assert.ok(feed.some((item) => item.id === "p:1"));
  assert.ok(feed.filter((item) => item.kind === "local_tweet").length >= 1);
});

test("composeFeed mixes observations with unopened saves", () => {
  const now = Date.now();
  const pages = [
    page({
      id: "yt1",
      title: "Never pressed play",
      importMeta: { source: "youtube", importedAt: now - 14 * 86400000 }
    }),
    page({
      id: "x1",
      title: "Bookmarked and forgotten",
      importMeta: { source: "twitter", importedAt: now - 21 * 86400000 }
    })
  ];
  const feed = composeFeed(pages, { mind: {}, events: [], now });
  assert.ok(feed.some((item) => item.kind === "local_tweet"));
  assert.ok(feed.some((item) => item.kind === "stalled_save"));
});
