import assert from "node:assert/strict";
import test from "node:test";
import {
  allTagsFromPages,
  contentTags,
  filterBarTags,
  mergeTags,
  normalizeTag,
  pageHasTags,
  parseTagInput,
  sortPages
} from "../extension/shared/tags.js";
import { isBookmark, isKept, isReadingList, isRss, isSave } from "../extension/shared/lists.js";
import { firstVisibleFilter, resolveFlags } from "../extension/shared/flags.js";
import { parseRssXml, rssItemsForFeed, parseRssUrlInput } from "../extension/import/rss.js";
import { uniqueItems } from "../extension/import/normalize.js";
import { buildVaultBundle } from "../extension/export/vault-format.js";
import { pageToMarkdown } from "../extension/export/obsidian.js";
import { feedItems, reasonFor } from "../extension/shared/feed.js";
import { hasOpened } from "../extension/shared/progress.js";
import { extractArticleSymbols, shouldExplainWithAi } from "../extension/content/article-symbols.js";
import { buildSymbolExplainPacket, glossText, plainProse } from "../extension/agent/packet.js";

test("tags normalize, merge, and attach derived source/comment labels", () => {
  assert.equal(normalizeTag("#Design Systems"), "design-systems");
  assert.deepEqual(parseTagInput("design, weekly, #later"), ["design", "weekly", "later"]);
  assert.deepEqual(parseTagInput("machine learning, later"), ["machine-learning", "later"]);
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
  const visible = filterBarTags([page]).map((row) => row.tag);
  assert.equal(visible.includes("user-comment"), false);
  assert.equal(visible.includes("bookmark"), false);
  assert.ok(visible.includes("habitat"));
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

test("only pages you acted on count as kept", () => {
  const browsed = {
    id: "browsed",
    readState: "in_progress",
    openedAt: Date.now(),
    progress: { maxPercent: 40 },
    highlights: [],
    threads: [],
    tags: []
  };
  assert.equal(isKept(browsed), false, "reading most of a page is not keeping it");
  assert.equal(isKept({ ...browsed, bookmarked: true }), true);
  assert.equal(isKept({ ...browsed, inReadingList: true }), true);
  assert.equal(isKept({ ...browsed, tags: ["later"] }), true);
  assert.equal(isKept({ ...browsed, highlights: [{ id: "h1" }] }), true);
  assert.equal(isKept({ ...browsed, threads: [{ id: "t1" }] }), true);
  assert.equal(isKept({ ...browsed, importMeta: { source: "youtube" } }), true);
  assert.equal(isKept({ ...browsed, readState: "parked" }), true);
  assert.equal(isKept({ ...browsed, readState: "read" }), false);
  assert.equal(isKept(null), false);
});

test("a link you queued but never opened does not count as opened", () => {
  // Shape produced by upsertPageFromVisit when the reading list is filled from a
  // right-clicked link rather than the tab you are looking at.
  const queuedLink = {
    id: "queued",
    inReadingList: true,
    openedAt: null,
    lastVisitedAt: 0,
    progress: { maxPercent: 0 }
  };
  assert.equal(hasOpened(queuedLink), false);
  assert.equal(hasOpened({ ...queuedLink, openedAt: Date.now() }), true);
  assert.equal(hasOpened({ ...queuedLink, progress: { maxPercent: 30 } }), true);
});

test("For you keeps out pages you merely browsed and finished", () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const pages = [
    {
      id: "read-through",
      title: "A page you browsed and finished",
      readState: "read",
      progress: { maxPercent: 100 },
      openedAt: now - day,
      lastVisitedAt: now - day
    },
    {
      id: "released",
      title: "A page you let go of",
      readState: "released",
      progress: { maxPercent: 4 },
      lastVisitedAt: now - 2 * day
    },
    {
      id: "stalled-save",
      title: "A save you never opened",
      readState: "unread",
      progress: { maxPercent: 0 },
      importMeta: { source: "youtube", kind: "watch_later", importedAt: now - 20 * day },
      createdAt: now - 20 * day
    },
    {
      id: "halfway",
      title: "A page you stopped halfway through",
      readState: "in_progress",
      progress: { maxPercent: 46 },
      openedAt: now - 3 * day,
      lastVisitedAt: now - 3 * day
    },
    {
      id: "snoozed",
      title: "A save you pushed away",
      readState: "unread",
      snoozedUntil: now + day,
      importMeta: { source: "reddit", kind: "saved", importedAt: now - 9 * day }
    }
  ];
  const ids = feedItems(pages, now).map((item) => item.page.id);
  assert.deepEqual([...ids].sort(), ["halfway", "stalled-save"]);
  // The raw trail would have shown everything but the released page, which is
  // exactly the pile the portal used to render.
  const trail = pages.filter((page) => page.readState !== "released");
  assert.equal(trail.length, 4);
});

test("a fresh install lands on the portal board, not the narrow timeline", () => {
  const fresh = resolveFlags({});
  assert.equal(fresh.experiment.variant, "C");
  assert.equal(fresh.flags.dashboardLayout, "compact");
  assert.equal(fresh.flags.forYouFeed, true);
  assert.equal(fresh.flags.articleSymbols, false);
  const junk = resolveFlags({ flags: { dashboardLayout: "nonsense" } });
  assert.equal(junk.flags.dashboardLayout, "compact");
});

test("article symbols pick up jargon and carry supporting text from the page", () => {
  const symbols = extractArticleSymbols([
    { id: "h1", heading: true, text: "The model picker is a dead end" },
    {
      id: "b1",
      text: "Open almost any AI product and you will find the same dropdown. The model picker is a dead end."
    },
    {
      id: "b2",
      text:
        "Real model independence means learning how each model works best before you ship anything to people."
    },
    {
      id: "b3",
      text:
        "That is why the control plane watches the work as it unfolds, including whether the agent is making progress."
    },
    {
      id: "b4",
      text: "The control plane also adapts the system around the model it happens to be driving."
    },
    {
      id: "b5",
      text: "A large language model (LLM) judge can rank a hollow build near the top of the pile."
    },
    { id: "b6", text: "We inspect the builds whenever the control plane and the LLM disagree." }
  ]);
  const byTerm = new Map(symbols.map((symbol) => [symbol.term.toLowerCase(), symbol]));

  // Headline copy is a claim, not a definition, so it must not become a symbol.
  assert.equal(byTerm.has("the model"), false);
  assert.equal(byTerm.has("model picker"), false);

  assert.equal(byTerm.get("llm").kind, "acronym");
  assert.equal(byTerm.get("llm").detail, "A large language model");
  assert.equal(byTerm.get("model independence").kind, "defined");
  assert.match(byTerm.get("model independence").detail, /^learning how each model works best/);
  assert.equal(byTerm.get("control plane").kind, "context");
  assert.match(byTerm.get("control plane").detail, /watches the work as it unfolds/);
  assert.equal(byTerm.get("control plane").count, 3);
  assert.equal(byTerm.get("control plane").anchorBlockId, "b3");
});

test("only terms the article never explains are worth an agent turn", () => {
  const symbols = extractArticleSymbols([
    {
      id: "b1",
      text: "Real model independence means learning how each model works best before you ship anything."
    },
    {
      id: "b2",
      text: "That is why the control plane watches the work as it unfolds, including whether it is making progress."
    },
    { id: "b3", text: "The control plane also adapts the system around the model it drives." },
    { id: "b4", text: "A large language model (LLM) judge can rank a hollow build near the top." },
    { id: "b5", text: "We inspect the builds whenever the control plane and the LLM disagree." }
  ]);
  const byTerm = new Map(symbols.map((symbol) => [symbol.term.toLowerCase(), symbol]));

  // The article defines these itself, so its own words are the honest answer.
  assert.equal(shouldExplainWithAi(byTerm.get("model independence")), false);
  assert.equal(shouldExplainWithAi(byTerm.get("llm")), false);
  // Leaned on three times, never explained: this is the one that repeats today.
  assert.equal(shouldExplainWithAi(byTerm.get("control plane")), true);

  assert.equal(shouldExplainWithAi(null), false);
  assert.equal(shouldExplainWithAi({ kind: "context", term: "own" }), false);
  assert.equal(shouldExplainWithAi({ kind: "context", term: "the very same thing" }), false);
});

test("agent prose is flattened and stripped of its lead-in before it reaches the card", () => {
  assert.equal(
    plainProse("**Control plane** is the `management` layer.\n\n- It [coordinates](https://x) work."),
    "Control plane is the management layer. It coordinates work."
  );
  // Both narration shapes the Cursor CLI produced against a real host.
  assert.equal(
    glossText("I'll read the LivePage packet and answer only the latest question from it.A control plane is the management layer."),
    "A control plane is the management layer."
  );
  assert.equal(
    glossText("Reading `packet.md` to find the latest user question.\nA control plane coordinates work."),
    "A control plane coordinates work."
  );
  // An explanation that merely mentions a page is not narration.
  assert.equal(glossText("A landing page is the first screen a visitor sees."), "A landing page is the first screen a visitor sees.");
});

test("symbol explanation packet asks for contextual knowledge without repeating the article", () => {
  const packet = buildSymbolExplainPacket({
    term: "control plane",
    pageTitle: "Adaptive agents",
    url: "https://example.com/agents",
    anchorText: "The control plane watches the work as it unfolds.",
    nearbyBlocks: [
      { text: "Agents use tools to complete long-running tasks." },
      { text: "The control plane watches the work as it unfolds." }
    ]
  });
  assert.match(packet, /Term: control plane/);
  assert.match(packet, /Wikipedia lead-section style/);
  assert.match(packet, /general knowledge to supply missing background/);
  assert.match(packet, /Do not quote, repeat, or closely paraphrase/);
  assert.match(packet, /Agents use tools/);
});

test("experiment C is compact and still keeps For you", () => {
  const c = resolveFlags({ experiment: { id: "dashboard-density", variant: "C" } });
  assert.equal(c.flags.forYouFeed, true);
  assert.equal(c.flags.dashboardLayout, "compact");
  assert.equal(c.flags.localTweets, false);
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

test("imported social saves are not auto-starred; rss is not either", () => {
  const [tweet, article] = uniqueItems([
    { url: "https://x.com/a/status/1", title: "star me", source: "twitter", kind: "bookmark" },
    { url: "https://example.com/rss-item", title: "feed me", source: "rss", kind: "rss", bookmarked: false, tags: ["demo"] }
  ]);
  assert.equal(tweet.bookmarked, false);
  assert.equal(article.bookmarked, false);
  assert.ok(article.tags.includes("demo"));
  assert.ok(tweet.tags.includes("twitter"));
  assert.ok(tweet.tags.includes("bookmark"));
  assert.ok(article.tags.includes("rss"));
});

test("reading list, bookmarks, and saves are separate memberships", () => {
  const save = uniqueItems([
    { url: "https://x.com/a/status/1", title: "a tweet", source: "twitter", kind: "saved" }
  ])[0];
  const harvested = { ...save, inReadingList: false, bookmarked: false };
  assert.equal(isSave(harvested), true);
  assert.equal(isReadingList(harvested), false);
  assert.equal(isBookmark(harvested), false);
  assert.equal(isReadingList({ ...harvested, inReadingList: true }), true);
  const starred = { url: "https://example.com/essay", bookmarked: true, inReadingList: false };
  assert.equal(isBookmark(starred), true);
  assert.equal(isSave(starred), false);
  assert.equal(isReadingList(starred), false);
  assert.equal(isRss({ importMeta: { source: "rss" } }), true);
  assert.equal(isSave({ importMeta: { source: "rss" } }), false);
});

test("rss textarea parses many URLs, optional per-line tags, and skips comments", () => {
  const feeds = parseRssUrlInput(`
# ignore me
https://example.com/feed.xml design weekly
https://other.com/rss, https://third.com/atom.xml
example.org/feed
  `);
  assert.equal(feeds.length, 4);
  assert.equal(feeds[0].url, "https://example.com/feed.xml");
  assert.ok(feeds[0].tags.includes("design"));
  assert.ok(feeds[0].tags.includes("weekly"));
  assert.equal(feeds[1].url, "https://other.com/rss");
  assert.equal(feeds[2].url, "https://third.com/atom.xml");
  assert.equal(feeds[3].url, "https://example.org/feed");
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
