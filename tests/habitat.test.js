import assert from "node:assert/strict";
import test from "node:test";
import {
  allTagsFromPages,
  contentTags,
  mergeTags,
  normalizeTag,
  pageHasTags,
  parseTagInput,
  sortPages
} from "../extension/shared/tags.js";
import { firstVisibleFilter, resolveFlags } from "../extension/shared/flags.js";
import { parseRssXml, rssItemsForFeed } from "../extension/import/rss.js";
import { uniqueItems } from "../extension/import/normalize.js";
import { buildVaultBundle } from "../extension/export/vault-format.js";
import { pageToMarkdown } from "../extension/export/obsidian.js";
import { reasonFor } from "../extension/shared/feed.js";

test("tags normalize, merge, and attach derived source/comment labels", () => {
  assert.equal(normalizeTag("#Design Systems"), "design-systems");
  assert.deepEqual(parseTagInput("design, weekly #later"), ["design", "weekly", "later"]);
  const page = {
    tags: ["habitat"],
    bookmarked: true,
    importMeta: { source: "rss", kind: "rss" },
    threads: [
      {
        messages: [
          { role: "user", content: "note" },
          { role: "agent", agent: "cursor", content: "reply" }
        ]
      }
    ]
  };
  const tags = contentTags(page);
  assert.ok(tags.includes("habitat"));
  assert.ok(tags.includes("bookmark"));
  assert.ok(tags.includes("rss"));
  assert.ok(tags.includes("user-comment"));
  assert.ok(tags.includes("ai-comment"));
  assert.ok(tags.includes("cursor"));
  assert.equal(pageHasTags(page, ["rss", "habitat"]), true);
  assert.equal(pageHasTags(page, ["youtube"]), false);
  const counted = allTagsFromPages([page]);
  assert.ok(counted[0].count >= 1);
});

test("sort prefers never-opened bookmarks when asked", () => {
  const now = Date.now();
  const pages = [
    { id: "new", title: "B", openedAt: now, createdAt: now, updatedAt: now, bookmarked: true },
    { id: "old", title: "A", openedAt: null, createdAt: now - 1000, updatedAt: now - 1000, bookmarked: true }
  ];
  assert.equal(sortPages(pages, "never-opened")[0].id, "old");
  assert.equal(sortPages(pages, "title")[0].id, "old");
});

test("experiment B hides For you until the flag is overridden", () => {
  const a = resolveFlags({ experiment: { id: "dashboard-density", variant: "A" } });
  assert.equal(a.flags.forYouFeed, true);
  assert.equal(a.flags.localTweets, false);
  assert.equal(a.flags.dashboardLayout, "feed");
  const b = resolveFlags({ experiment: { id: "dashboard-density", variant: "B" } });
  assert.equal(b.flags.forYouFeed, false);
  assert.equal(firstVisibleFilter(b.flags), "reading");
  const override = resolveFlags({
    experiment: { id: "dashboard-density", variant: "B" },
    flags: { forYouFeed: true }
  });
  assert.equal(override.flags.forYouFeed, true);
});

test("legacy tweet setting still wins over the default-off experiment", () => {
  const resolved = resolveFlags({
    localTweetsEnabled: true,
    experiment: { id: "dashboard-density", variant: "A" }
  });
  assert.equal(resolved.flags.localTweets, true);
});

test("rss and atom parse into tagged items that are not auto-bookmarked", () => {
  const rss = parseRssXml(
    `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Systems</title>
      <item>
        <title>Open files</title>
        <link>https://example.com/open</link>
        <description>plain markdown</description>
        <category>okf</category>
      </item>
    </channel></rss>`,
    "https://example.com/feed.xml"
  );
  assert.equal(rss.title, "Systems");
  assert.equal(rss.items[0].url, "https://example.com/open");
  assert.ok(rss.items[0].tags.includes("okf"));

  const atom = parseRssXml(
    `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom</title>
      <entry>
        <title>Hello</title>
        <link rel="alternate" href="https://example.com/hello"/>
        <summary>hi</summary>
      </entry>
    </feed>`
  );
  assert.equal(atom.items[0].url, "https://example.com/hello");

  const items = rssItemsForFeed({ id: "rss_1", title: "Systems", tags: ["weekly"], url: "https://example.com/feed.xml" }, rss);
  assert.equal(items[0].bookmarked, false);
  assert.ok(items[0].tags.includes("weekly"));
  assert.ok(items[0].tags.includes("rss"));
  assert.equal(items[0].importMeta.source, "rss");
});

test("imported social saves still star; rss does not", () => {
  const [tweet, article] = uniqueItems([
    { url: "https://x.com/a/status/1", title: "star me", source: "twitter", kind: "bookmark" },
    { url: "https://example.com/rss-item", title: "feed me", source: "rss", kind: "rss", bookmarked: false, tags: ["demo"] }
  ]);
  assert.equal(tweet.bookmarked, true);
  assert.equal(article.bookmarked, false);
  assert.ok(article.tags.includes("demo"));
});

test("vault bundle is open markdown plus a machine catalog", () => {
  const page = {
    id: "p_1",
    title: "Essay",
    canonicalUrl: "https://example.com/essay",
    url: "https://example.com/essay",
    domain: "example.com",
    readState: "in_progress",
    bookmarked: true,
    tags: ["trails"],
    updatedAt: Date.parse("2026-08-27T00:00:00Z"),
    progress: { maxPercent: 40 },
    importMeta: { source: "rss" },
    parsed: { excerpt: "clip", headings: ["Why"] },
    highlights: [],
    threads: []
  };
  const bundle = buildVaultBundle([page], { obsidianFolder: "LivePage", rssFeeds: [{ url: "https://example.com/feed.xml" }] });
  assert.equal(bundle.folder, "livepage");
  const names = bundle.files.map((file) => file.path.join("/"));
  assert.ok(names.includes("catalog.json"));
  assert.ok(names.includes("index.md"));
  assert.ok(names.includes("config.json"));
  const catalogFile = bundle.files.find((file) => file.path.join("/") === "catalog.json");
  const catalog = JSON.parse(catalogFile.content);
  assert.equal(catalog.format, "livepage-okf/v1");
  assert.ok(catalog.pages[0].tags.includes("trails"));
  const md = pageToMarkdown(page);
  assert.match(md, /source: rss/);
  assert.match(md, /progress: 40/);
});

test("old bookmarks say they were never opened, with tags", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");
  const page = {
    id: "bm",
    title: "old star",
    createdAt: now - 40 * 86400000,
    openedAt: null,
    bookmarked: true,
    tags: ["design"],
    progress: { maxPercent: 0 },
    threads: []
  };
  assert.match(reasonFor(page, {}, now), /Bookmarked/);
  assert.match(reasonFor(page, {}, now), /#design/);
  assert.match(reasonFor(page, {}, now), /never opened/);
});

test("mergeTags drops empties and duplicates", () => {
  assert.deepEqual(mergeTags(["A", "a"], ["", "A!"]), ["a"]);
});
