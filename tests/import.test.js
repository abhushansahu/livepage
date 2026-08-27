import assert from "node:assert/strict";
import test from "node:test";
import { classifyLibraryUrl, isLibraryUrl } from "../extension/import/sources.js";
import { itemsFromRedditListing } from "../extension/import/reddit.js";
import { extractAssignedJson, itemsFromYtInitialData } from "../extension/import/youtube.js";
import { uniqueItems } from "../extension/import/normalize.js";
import { harvestTwitterDom } from "../extension/import/twitter.js";

test("library URLs classify X bookmarks, Reddit saved, and YouTube Watch Later", () => {
  assert.equal(classifyLibraryUrl("https://x.com/i/bookmarks")?.id, "twitter");
  assert.equal(classifyLibraryUrl("https://twitter.com/i/bookmarks/all")?.id, "twitter");
  assert.equal(classifyLibraryUrl("https://www.reddit.com/saved")?.id, "reddit");
  assert.equal(classifyLibraryUrl("https://old.reddit.com/user/abhushan/saved")?.id, "reddit");
  assert.equal(classifyLibraryUrl("https://www.youtube.com/playlist?list=WL")?.id, "youtube");
  assert.equal(classifyLibraryUrl("https://www.youtube.com/watch?v=abc"), null);
  assert.equal(isLibraryUrl("https://www.reddit.com/r/all"), false);
});

test("reddit saved listing maps link posts to the destination URL", () => {
  const items = itemsFromRedditListing({
    data: {
      children: [
        {
          data: {
            id: "abc",
            title: "Why trails beat cabinets",
            url: "https://www.theatlantic.com/essay?utm_source=reddit",
            permalink: "/r/TrueReddit/comments/abc/why/",
            subreddit: "TrueReddit",
            is_self: false,
            selftext: ""
          }
        },
        {
          data: {
            id: "def",
            title: "Self post",
            url: "https://www.reddit.com/r/test/comments/def/self/",
            permalink: "/r/test/comments/def/self/",
            subreddit: "test",
            is_self: true,
            selftext: "body"
          }
        }
      ]
    }
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://theatlantic.com/essay");
  assert.equal(items[0].importMeta.source, "reddit");
  assert.match(items[1].url, /reddit.com\/r\/test/);
});

test("youtube watch later videos are collected from ytInitialData", () => {
  const html = `var ytInitialData = {"contents":{"playlistVideoRenderer":{"videoId":"abc123","title":{"runs":[{"text":"Never watched"}]},"shortBylineText":{"runs":[{"text":"Channel"}]}}}};`;
  const data = extractAssignedJson(html, "ytInitialData");
  const items = itemsFromYtInitialData(data);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://youtube.com/watch?v=abc123");
  assert.equal(items[0].title, "Never watched");
  assert.equal(items[0].importMeta.kind, "watch_later");
});

test("duplicate import URLs collapse", () => {
  const items = uniqueItems([
    { url: "https://x.com/a/status/1", title: "one", source: "twitter" },
    { url: "https://x.com/a/status/1?utm_source=share", title: "one again", source: "twitter" }
  ]);
  assert.equal(items.length, 1);
});

test("twitter bookmark harvest prefers an outbound link when present", () => {
  const article = {
    querySelectorAll: (sel) => {
      if (sel === "a[href]") {
        return [
          { getAttribute: () => "/visakanv/status/123", href: "/visakanv/status/123" },
          { getAttribute: () => "https://example.com/essay", href: "https://example.com/essay" }
        ];
      }
      return [];
    },
    querySelector: (sel) => {
      if (sel === '[data-testid="tweetText"]') return { textContent: "bookmarks are a graveyard" };
      if (sel === '[data-testid="User-Name"]') return { textContent: "visakanv\n@visakanv" };
      return null;
    }
  };
  const doc = { querySelectorAll: () => [article] };
  const items = harvestTwitterDom(doc, "https://x.com/i/bookmarks");
  assert.equal(items[0].url, "https://example.com/essay");
  assert.match(items[0].title, /graveyard/);
});
