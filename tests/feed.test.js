import assert from "node:assert/strict";
import test from "node:test";
import { feedItems, hasOpened, scorePage } from "../extension/shared/feed.js";

test("unopened Watch Later outranks a finished page", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");
  const youtube = {
    id: "yt",
    title: "Never pressed play",
    createdAt: now - 14 * 86400000,
    lastVisitedAt: 0,
    openedAt: null,
    bookmarked: true,
    readState: "unread",
    importMeta: { source: "youtube", kind: "watch_later", importedAt: now - 14 * 86400000 },
    progress: { maxPercent: 0 },
    threads: []
  };
  const done = {
    id: "done",
    title: "Finished",
    createdAt: now - 2 * 86400000,
    lastVisitedAt: now,
    openedAt: now,
    bookmarked: true,
    readState: "read",
    progress: { maxPercent: 96 },
    threads: []
  };
  assert.equal(hasOpened(youtube), false);
  assert.ok(scorePage(youtube, now) > scorePage(done, now));
  const feed = feedItems([youtube, done], now);
  assert.equal(feed[0].page.id, "yt");
  assert.match(feed[0].reason, /Watch Later|never pressed play/i);
});

test("feed mixes sources instead of dumping one site in a row", () => {
  const now = Date.now();
  const pages = [];
  for (let i = 0; i < 4; i += 1) {
    pages.push({
      id: `yt${i}`,
      title: `Video ${i}`,
      createdAt: now - (10 + i) * 86400000,
      importMeta: { source: "youtube", importedAt: now - (10 + i) * 86400000 },
      progress: { maxPercent: 0 },
      bookmarked: true,
      readState: "unread",
      threads: []
    });
    pages.push({
      id: `x${i}`,
      title: `Tweet ${i}`,
      createdAt: now - (9 + i) * 86400000,
      importMeta: { source: "twitter", importedAt: now - (9 + i) * 86400000 },
      progress: { maxPercent: 0 },
      bookmarked: true,
      readState: "unread",
      threads: []
    });
  }
  const feed = feedItems(pages, now);
  const firstFour = feed.slice(0, 4).map((item) => item.page.importMeta.source);
  assert.ok(firstFour.includes("youtube") && firstFour.includes("twitter"));
  assert.notEqual(firstFour[0], firstFour[1]);
});

test("awaiting review becomes its own feed card", () => {
  const now = Date.now();
  const page = {
    id: "p1",
    title: "Essay",
    createdAt: now - 86400000,
    lastVisitedAt: now - 3600000,
    openedAt: now - 3600000,
    readState: "in_progress",
    progress: { maxPercent: 42 },
    highlights: [{ id: "h1", text: "the page is the place" }],
    threads: [
      {
        id: "t1",
        highlightId: "h1",
        messages: [{ role: "user", content: "still mine", createdAt: now - 60000 }]
      }
    ]
  };
  const feed = feedItems([page], now);
  assert.equal(feed[0].kind, "review");
  assert.match(feed[0].reason, /waiting/i);
});
