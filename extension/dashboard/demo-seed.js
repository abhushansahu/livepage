import { emptyPage } from "../storage/store.js";

/**
 * Demo habitat only. Fills the dashboard so Home / Reading list / Bookmarks / Review
 * can be shown without a prior browsing session. Never runs inside the packed extension.
 */
export async function ensureDemoHabitat(call) {
  if (globalThis.location?.protocol === "chrome-extension:") return;
  const existing = (await call("LIST_PAGES")) || [];
  const now = Date.now();
  const origin = location.origin;
  const seeds = [...buildSeeds(origin, now), ...buildImportSeeds(now)];
  for (const page of seeds) {
    const found = existing.find((p) => p.id === page.id);
    if (page.importMeta && found?.importMeta) continue;
    if (!page.importMeta && found?.threads?.length && found.progress?.maxPercent) continue;
    await call("SAVE_PAGE", { page: found ? { ...page, ...found, ...enrich(found, page) } : page });
  }
  const settings = (await call("GET_SETTINGS")) || {};
  if (!(settings.rssFeeds || []).length) {
    await call("SAVE_SETTINGS", {
      rssFeeds: [
        {
          id: "rss_demo",
          url: `${origin}/demo/feed.xml`,
          title: "LivePage demo feed",
          tags: ["demo", "systems"],
          enabled: true,
          addedAt: now
        }
      ]
    });
  }
  const check = (await call("LIST_PAGES")) || [];
  if (!check.length) throw new Error("Demo seed wrote no pages");
}

function enrich(found, seed) {
  return {
    progress: found.progress?.maxPercent ? found.progress : seed.progress,
    readState: found.readState && found.readState !== "unread" ? found.readState : seed.readState,
    bookmarked: found.bookmarked || seed.bookmarked,
    highlights: found.highlights?.length ? found.highlights : seed.highlights,
    threads: found.threads?.length ? found.threads : seed.threads,
    parsed: found.parsed?.excerpt ? found.parsed : seed.parsed,
    why: found.why || seed.why,
    tags: found.tags?.length ? found.tags : seed.tags
  };
}

function buildSeeds(origin, now) {
  return [
    articleSeed(origin, now),
    feedSeed(origin, now),
    intentionSeed(origin, now)
  ];
}

function articleSeed(origin, now) {
  const page = emptyPage(`${origin}/demo/article.html`, {
    title: "A selection on a live page is a decision site"
  });
  page.createdAt = now - 4 * 3600000;
  page.lastVisitedAt = now - 18 * 60000;
  page.bookmarked = true;
  page.tags = ["habitat", "live"];
  page.why = "Came back to argue with the filing-cabinet line.";
  page.readState = "in_progress";
  page.progress = { percent: 42, maxPercent: 42, scrollY: 920, updatedAt: now - 18 * 60000 };
  page.parsed = {
    excerpt: "Most tools treat the web as something to clip and file. That misses the moment that actually matters: you are in the habitat of the page, mid-thought.",
    headings: ["Why the live page", "Comments as conversations", "Compost, not a second brain"],
    wordCount: 380,
    contentHash: "demo-article",
    blocks: []
  };
  page.highlights = [
    highlight("hl_seed_habitat", "moss", "you are in the habitat of the page, mid-thought", now - 3 * 3600000),
    highlight("hl_seed_place", "sand", "the spatial memory of “it was halfway down”", now - 2 * 3600000)
  ];
  page.threads = [
    {
      id: "th_seed_habitat",
      highlightId: "hl_seed_habitat",
      parentId: null,
      branchLabel: "main",
      status: "open",
      createdAt: now - 3 * 3600000,
      messages: [
        message("msg_a1", "user", null, "This is the line I want the agent to argue with.", now - 3 * 3600000),
        message(
          "msg_a2",
          "agent",
          "cursor",
          "What would you drop from this article without losing the claim?",
          now - 2.5 * 3600000
        ),
        message("msg_a3", "user", null, "The filing-cabinet metaphor. Keep the compost.", now - 20 * 60000)
      ]
    },
    {
      id: "th_seed_place",
      highlightId: "hl_seed_place",
      parentId: null,
      branchLabel: "main",
      status: "open",
      createdAt: now - 2 * 3600000,
      messages: [
        message("msg_b1", "user", null, "Bookmark this for the manifesto.", now - 2 * 3600000),
        message(
          "msg_b2",
          "agent",
          "claude",
          "Halfway-down is a place-memory, not a clip. Keep the live layout.",
          now - 90 * 60000
        )
      ]
    }
  ];
  return page;
}

function feedSeed(origin, now) {
  const page = emptyPage(`${origin}/demo/feed.html`, {
    title: "A feed that never ends"
  });
  page.createdAt = now - 30 * 3600000;
  page.lastVisitedAt = now - 26 * 3600000;
  page.infiniteScroll = true;
  page.readState = "unread";
  page.progress = { percent: 6, maxPercent: 6, scrollY: 180, updatedAt: now - 26 * 3600000 };
  page.parsed = {
    excerpt: "This feed keeps growing. A highlight here would not survive a reload with a stable anchor.",
    headings: ["Card 1"],
    wordCount: 40,
    contentHash: "demo-feed",
    blocks: []
  };
  page.why = "Opened by accident. Still sitting at the top.";
  page.tags = ["feeds"];
  return page;
}

function intentionSeed(origin, now) {
  const page = emptyPage(`${origin}/docs/intention.md`, {
    title: "Exploring the intention: action-driven web annotation"
  });
  page.createdAt = now - 10 * 24 * 3600000;
  page.lastVisitedAt = now - 2 * 24 * 3600000;
  page.bookmarked = true;
  page.tags = ["intention", "mirror"];
  page.readState = "read";
  page.progress = { percent: 96, maxPercent: 96, scrollY: 8400, updatedAt: now - 2 * 24 * 3600000 };
  page.parsed = {
    excerpt: "Stay inside the live web’s energy while converting it into owned thought, open questions, and next actions.",
    headings: ["What you are really asking for", "The Google Doc on any webpage metaphor"],
    wordCount: 6200,
    contentHash: "intention",
    blocks: []
  };
  page.why = "The frozen map. Read through; kept as a bookmark.";
  page.highlights = [
    highlight("hl_seed_mission", "lemon", "mission control for open cognitive loops", now - 9 * 24 * 3600000)
  ];
  page.threads = [
    {
      id: "th_seed_mission",
      highlightId: "hl_seed_mission",
      parentId: null,
      branchLabel: "main",
      status: "open",
      createdAt: now - 9 * 24 * 3600000,
      messages: [
        message("msg_c1", "user", null, "This is the dashboard job, not a library.", now - 9 * 24 * 3600000)
      ]
    }
  ];
  return page;
}

function highlight(id, color, text, createdAt) {
  return { id, color, text, prefix: "", suffix: "", createdAt, threadId: null };
}

function message(id, role, agent, content, createdAt) {
  return { id, role, agent, content, createdAt };
}

function buildImportSeeds(now) {
  return [
    imported({
      url: "https://www.youtube.com/watch?v=lp-watch-later-01",
      title: "How to remember what you read — without a second brain",
      excerpt: "Memory is a trail you walk again, not a vault you fill. Watch later, then never watch.",
      author: "How to Take Notes",
      source: "youtube",
      kind: "watch_later",
      tags: ["memory"],
      days: 14
    }, now),
    imported({
      url: "https://www.youtube.com/watch?v=lp-watch-later-02",
      title: "The case against finishing every article",
      excerpt: "Abandonment is a skill. You saved this to Watch Later because the title rhymed with a mood.",
      author: "The Browser",
      source: "youtube",
      kind: "watch_later",
      days: 3
    }, now),
    imported({
      url: "https://x.com/visakanv/status/1800000000000000001",
      title: "bookmarks are a graveyard of intended selves",
      excerpt: "Every bookmark is a person you meant to be next week. The feed should bring that person back.",
      author: "@visakanv",
      source: "twitter",
      kind: "bookmark",
      days: 6
    }, now),
    imported({
      url: "https://x.com/andy_matuschak/status/1800000000000000002",
      title: "Note-taking is not the work. The work is the next question.",
      excerpt: "You starred this on X, opened nothing, and the question went cold.",
      author: "@andy_matuschak",
      source: "twitter",
      kind: "bookmark",
      tags: ["questions"],
      days: 21
    }, now),
    imported({
      url: "https://www.theatlantic.com/livepage-saved-essay",
      title: "Why we never return to the tabs we save",
      excerpt: "Saved from r/TrueReddit. The article is still the live page. You have not scrolled a pixel.",
      author: "r/TrueReddit",
      source: "reddit",
      kind: "saved",
      days: 12
    }, now),
    imported({
      url: "https://www.reddit.com/r/slatestarcodex/comments/lpdemo/on_trails/",
      title: "On trails, not filing cabinets",
      excerpt: "A thread you saved because someone disagreed well. Still unread.",
      author: "r/slatestarcodex",
      source: "reddit",
      kind: "saved",
      days: 5
    }, now),
    imported({
      url: "https://news.ycombinator.com/item?id=lp-hn-1",
      title: "Show HN: a dashboard that is a feed, not a library",
      excerpt: "Favorited on HN a month ago. The comments are the live page.",
      author: "HN",
      source: "hn",
      kind: "favorite",
      days: 28
    }, now),
    imported({
      url: "https://getpocket.com/never-opened-essay",
      title: "Pocket is full of people you were going to become",
      excerpt: "Saved in Pocket. The interest dies when the pile has no surface to scroll.",
      author: "Pocket",
      source: "pocket",
      kind: "saved",
      days: 9
    }, now),
    imported({
      url: "https://example.com/open-knowledge-files",
      title: "Open knowledge should travel as files, not as a product lock-in",
      excerpt: "From a tagged RSS feed. The vault is a git repo both you and an agent can walk.",
      author: "LivePage demo feed",
      source: "rss",
      kind: "rss",
      tags: ["systems", "okf", "demo"],
      bookmarked: false,
      days: 2
    }, now)
  ];
}

function imported(spec, now) {
  const created = now - spec.days * 24 * 3600000;
  const page = emptyPage(spec.url, { title: spec.title, why: spec.excerpt });
  page.createdAt = created;
  page.lastVisitedAt = 0;
  page.openedAt = null;
  page.bookmarked = spec.bookmarked !== false;
  page.tags = spec.tags || [];
  page.readState = "unread";
  page.parsed = { ...page.parsed, excerpt: spec.excerpt };
  page.importMeta = {
    source: spec.source,
    kind: spec.kind,
    author: spec.author,
    externalId: spec.url,
    importedAt: created,
    lastSyncedAt: now
  };
  page.progress = { percent: 0, maxPercent: 0, scrollY: 0, updatedAt: created };
  return page;
}
