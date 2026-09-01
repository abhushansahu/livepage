import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { classifyLibraryUrl, isLibraryUrl, isRefreshSource } from "../extension/import/sources.js";
import { itemsFromRedditListing } from "../extension/import/reddit.js";
import { extractAssignedJson, itemsFromYtInitialData } from "../extension/import/youtube.js";
import { uniqueItems } from "../extension/import/normalize.js";
import { harvestDocument } from "../extension/import/harvest.js";
import { harvestTwitterDom, scrapeTwitterBookmarksFromPage, scrapeCapturedTwitterBookmarksFromPage, itemsFromTwitterGraphql } from "../extension/import/twitter.js";

test("library URLs classify X bookmarks, Reddit saved, and YouTube Watch Later", () => {
  assert.equal(classifyLibraryUrl("https://x.com/i/bookmarks")?.id, "twitter");
  assert.equal(classifyLibraryUrl("https://twitter.com/i/bookmarks/all")?.id, "twitter");
  assert.equal(classifyLibraryUrl("https://www.reddit.com/saved")?.id, "reddit");
  assert.equal(classifyLibraryUrl("https://old.reddit.com/user/abhushan/saved")?.id, "reddit");
  assert.equal(classifyLibraryUrl("https://www.youtube.com/playlist?list=WL")?.id, "youtube");
  assert.equal(classifyLibraryUrl("https://www.youtube.com/watch?v=abc"), null);
  assert.equal(isLibraryUrl("https://www.reddit.com/r/all"), false);
  assert.equal(isRefreshSource("twitter"), true);
  assert.equal(isRefreshSource("pocket"), false);
  assert.equal(isRefreshSource("hn"), false);
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

test("twitter bookmark harvest keeps the tweet URL, not an outbound card link", () => {
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
  assert.equal(items[0].url, "https://x.com/visakanv/status/123");
  assert.match(items[0].title, /graveyard/);
  assert.equal(items[0].bookmarked, false);
});

test("twitter harvest keeps a status URL when there is no outbound link", () => {
  const article = {
    querySelectorAll: (sel) => {
      if (sel === "a[href]") {
        return [{ getAttribute: () => "/visakanv/status/123", href: "/visakanv/status/123" }];
      }
      return [];
    },
    querySelector: (sel) => {
      if (sel === '[data-testid="tweetText"]') return { textContent: "just a thought" };
      return null;
    }
  };
  const doc = { querySelectorAll: () => [article] };
  const items = harvestTwitterDom(doc, "https://x.com/i/bookmarks");
  assert.match(items[0].url, /status\/123/);
});

test("twitter harvest falls back to status links when articles are missing", () => {
  const doc = {
    querySelectorAll: (sel) => {
      if (String(sel).includes("article") || String(sel).includes("cellInnerDiv")) return [];
      if (String(sel).includes("/status/")) {
        return [
          {
            getAttribute: () => "https://x.com/a/status/99",
            href: "https://x.com/a/status/99",
            textContent: "hello from x bookmarks"
          }
        ];
      }
      return [];
    }
  };
  const items = harvestTwitterDom(doc, "https://x.com/i/bookmarks");
  assert.equal(items.length, 1);
  assert.match(items[0].url, /status\/99/);
});

test("twitter harvest collapses photo permalinks onto the status URL", () => {
  const article = {
    querySelectorAll: (sel) => {
      if (sel === "a[href]") {
        return [{ getAttribute: () => "/a/status/99/photo/1", href: "/a/status/99/photo/1" }];
      }
      return [];
    },
    querySelector: () => ({ textContent: "pic tweet" })
  };
  const items = harvestTwitterDom({ querySelectorAll: () => [article] }, "https://x.com/i/bookmarks");
  assert.equal(items[0].url, "https://x.com/a/status/99");
});

test("twitter graphql bookmarks parse tweet_results into status URLs", () => {
  const payload = {
    data: {
      bookmark_timeline_v2: {
        timeline: {
          instructions: [
            {
              entries: [
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          rest_id: "99",
                          legacy: { full_text: "keep this" },
                          core: {
                            user_results: {
                              result: { legacy: { screen_name: "visakanv", name: "Visa" } }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    }
  };
  const items = itemsFromTwitterGraphql([payload]);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://x.com/visakanv/status/99");
  assert.match(items[0].title, /keep this/);
});

test("injected twitter graphql reader is a self-contained function Chrome can serialize", () => {
  const src = scrapeCapturedTwitterBookmarksFromPage.toString();
  assert.match(src, /__LP_X_BOOKMARKS/);
  assert.equal(src.includes("uniqueItems"), false);
  assert.equal(src.includes("collectByKey"), false);
});

test("injected twitter scraper is a self-contained function Chrome can serialize", () => {
  const src = scrapeTwitterBookmarksFromPage.toString();
  assert.match(src, /data-testid="tweet"/);
  assert.equal(src.includes("uniqueItems"), false);
});

test("the x hook leaves binary XHR responses alone", async () => {
  const src = await readFile(new URL("../extension/import/x-hook.js", import.meta.url), "utf8");

  class FakeXHR {
    constructor() {
      this.handlers = [];
    }
    open() {}
    send() {}
    addEventListener(type, fn) {
      if (type === "load") this.handlers.push(fn);
    }
    finish() {
      for (const fn of this.handlers) fn.call(this);
    }
  }

  const saved = { xhr: globalThis.XMLHttpRequest, fetch: globalThis.fetch };
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    new Function(src)();

    const bookmarksUrl = "https://x.com/i/api/graphql/abc/Bookmarks";
    const binary = new FakeXHR();
    binary.open("GET", bookmarksUrl);
    binary.send();
    binary.responseType = "arraybuffer";
    Object.defineProperty(binary, "responseText", {
      get() {
        throw new Error("InvalidStateError");
      }
    });
    binary.finish();
    assert.deepEqual(globalThis.__LP_X_BOOKMARKS, [], "binary bodies are skipped, not read");

    const text = new FakeXHR();
    text.open("GET", bookmarksUrl);
    text.send();
    text.responseType = "";
    text.responseText = JSON.stringify({ data: { ok: true } });
    text.finish();
    assert.equal(globalThis.__LP_X_BOOKMARKS.length, 1, "text bodies still get captured");

    const media = new FakeXHR();
    media.open("GET", "https://video.twimg.com/clip.mp4");
    media.send();
    Object.defineProperty(media, "responseText", {
      get() {
        throw new Error("should never be read");
      }
    });
    media.finish();
    assert.equal(globalThis.__LP_X_BOOKMARKS.length, 1, "unrelated URLs are never read");
  } finally {
    globalThis.XMLHttpRequest = saved.xhr;
    globalThis.fetch = saved.fetch;
    delete globalThis.__LP_X_HOOK;
    delete globalThis.__LP_X_BOOKMARKS;
  }
});

test("refresh harvest ignores Pocket, HN, and Chrome-style lists", () => {
  const doc = {
    querySelectorAll: () => [{ href: "https://example.com/story", textContent: "A long enough title here", getAttribute: () => "https://example.com/story" }]
  };
  assert.deepEqual(harvestDocument(doc, "https://getpocket.com/saves"), []);
  assert.deepEqual(harvestDocument(doc, "https://news.ycombinator.com/favorites"), []);
  assert.deepEqual(harvestDocument(doc, "https://x.com/home"), []);
});
