import { emptyPage } from "../storage/store.js";

/**
 * Demo habitat only. Fills the dashboard so Home / Reading list / Bookmarks / Review
 * can be shown without a prior browsing session. Never runs inside the packed extension.
 */
export async function ensureDemoHabitat(call) {
  if (globalThis.chrome?.runtime?.id) return;
  const existing = (await call("LIST_PAGES")) || [];
  const seeded = existing.some((page) => page.progress?.maxPercent > 0 && (page.threads || []).length);
  if (seeded && existing.length >= 3) return;

  const now = Date.now();
  const origin = location.origin;
  for (const page of buildSeeds(origin, now)) {
    const found = existing.find((p) => p.id === page.id);
    if (found?.threads?.length && found.progress?.maxPercent) continue;
    await call("SAVE_PAGE", { page: found ? { ...page, ...found, ...enrich(found, page) } : page });
  }
}

function enrich(found, seed) {
  return {
    progress: found.progress?.maxPercent ? found.progress : seed.progress,
    readState: found.readState && found.readState !== "unread" ? found.readState : seed.readState,
    bookmarked: found.bookmarked || seed.bookmarked,
    highlights: found.highlights?.length ? found.highlights : seed.highlights,
    threads: found.threads?.length ? found.threads : seed.threads,
    parsed: found.parsed?.excerpt ? found.parsed : seed.parsed,
    why: found.why || seed.why
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
  return page;
}

function intentionSeed(origin, now) {
  const page = emptyPage(`${origin}/docs/intention.md`, {
    title: "Exploring the intention: action-driven web annotation"
  });
  page.createdAt = now - 10 * 24 * 3600000;
  page.lastVisitedAt = now - 2 * 24 * 3600000;
  page.bookmarked = true;
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
