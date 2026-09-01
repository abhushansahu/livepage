import { call, onBroadcast } from "../shared/bridge.js";
import { parseDocument } from "../parse/page-parser.js";
import {
  createInfiniteScrollDetector,
  evaluateInfiniteScroll
} from "../parse/infinite-scroll.js";
import { quoteFromRange, unwrapHighlight } from "../parse/quote.js";
import { applyRangeHighlight, restoreHighlights, recolorMarks } from "./highlights.js";
import { Overlay } from "./overlay.js";
import { toolbarAction, rangeRect } from "./selection.js";
import { COLOR_IDS } from "../shared/colors.js";
import { measureScrollProgress } from "../shared/progress.js";
import { detectFeeds } from "../import/rss.js";
import { parseTagInput } from "../shared/tags.js";
import { resolveFlags } from "../shared/flags.js";
import { enableArticleSymbols } from "./article-symbols.js";

if (globalThis.__LP_CONTENT_STARTED) {
  throw new Error("LivePage content already started");
}
globalThis.__LP_CONTENT_STARTED = true;

const overlay = new Overlay();
let page = null;
let settings = { defaultColor: "lemon", lockInfiniteScroll: true, allowInfiniteSnapshot: true };
let infinite = { infinite: false, reason: null };
let reachedPercent = 0;
let savedRange = null;
let savedRect = null;
let gestureSelected = false;

overlay.handlers = {
  onOpenHighlight: (id) => openOrCreateThread(id),
  onNote: (threadId, content) =>
    mutate("ADD_MESSAGE", { pageId: page.id, threadId, message: { role: "user", content } }),
  onAgent: (threadId, ask, agent) => sendToAgent(threadId, ask, agent),
  onAgentReply: (threadId, content, agent) =>
    mutate("ADD_MESSAGE", {
      pageId: page.id,
      threadId,
      message: { role: "agent", agent, content }
    }),
  onFork: (threadId, messageId, branchLabel) =>
    mutate("FORK_THREAD", { pageId: page.id, threadId, messageId, branchLabel }).then((data) => {
      overlay.openThread(data.thread.id);
    }),
  onDeleteMessage: (threadId, messageId) =>
    mutate("DELETE_MESSAGE", { pageId: page.id, threadId, messageId }),
  onRecolorHighlight: (highlightId, color) => recolorHighlight(highlightId, color),
  onMoveHighlight: (highlightId) => moveHighlight(highlightId),
  onDeleteHighlight: (highlightId) => deleteHighlight(highlightId),
  onSearchMentions: (query) => searchMentions(query),
  onOpenMention: (pageId, threadId) => openMention(pageId, threadId),
  onRefresh: () => refreshPage()
};

onBroadcast((message) => {
  if (message.kind === "CONTEXT_ACTION") handleContext(message.action);
  if (message.kind === "TOAST" && message.text) overlay.toast(message.text);
  if (message.kind === "SETTINGS_CHANGED" && message.settings) {
    settings = message.settings;
    overlay.setPreferences(settings);
  }
});
boot().catch((error) => console.warn("LivePage failed to start", error));

async function boot() {
  infinite = evaluateInfiniteScroll(location.href, document);
  watchSelection();
  watchMarks();

  try {
    settings = (await call("GET_SETTINGS")) || settings;
    overlay.setPreferences(settings);
  } catch (error) {
    console.warn("LivePage settings unavailable", error);
  }
  const { flags } = resolveFlags(settings);

  try {
    await overlay.ready;
  } catch (error) {
    console.warn("LivePage overlay failed", error);
  }
  maybeToolbar();

  let parsed = { blocks: [] };
  try {
    parsed = parseDocument(document, location.href);
  } catch (error) {
    console.warn("LivePage parse failed", error);
  }
  if (!infinite.infinite) infinite = evaluateInfiniteScroll(location.href, document);
  try {
    // Opening a page is not an act of keeping it. This refreshes a page you
    // already kept and returns null for one you are merely reading, which
    // stays entirely in memory until you highlight, star, or list it.
    page = await call("VISIT_PAGE", {
      url: location.href,
      title: document.title,
      parsed,
      infiniteScroll: infinite.infinite,
      createIfMissing: false
    });
    if (page) {
      restoreHighlights(document.body, page.highlights);
      overlay.setPage(page);
      openLinkedThread();
    }
    watchInfinite();
    watchScroll();
  } catch (error) {
    console.warn("LivePage visit failed", error);
  }
  if (flags.articleSymbols) {
    try {
      enableArticleSymbols(document, parsed);
    } catch (error) {
      console.warn("LivePage article symbols failed", error);
    }
  }
  if (flags.rss) offerRssIfAny();
}

function watchInfinite() {
  if (infinite.infinite) return;
  const detector = createInfiniteScrollDetector({
    initial: false,
    minGrowths: 2,
    threshold: 0.35
  });
  detector.onFlag(() => {
    infinite = { infinite: true, reason: "This page grew while you were reading." };
    if (page?.id) call("PATCH_PAGE", { id: page.id, patch: { infiniteScroll: true } });
  });
  detector.start();
}

/**
 * Infinite feeds only hold a stable anchor against a parsed view, so take a
 * fresh one right before the mark lands. Nothing is announced: the highlight
 * itself is the feedback.
 */
async function anchorInfiniteView() {
  if (!settings.lockInfiniteScroll || !infinite.infinite) return;
  const parsed = parseDocument(document, location.href);
  page = await call("PATCH_PAGE", { id: page.id, patch: { parsed, infiniteScroll: true } });
  page = await call("SNAPSHOT_PAGE", { pageId: page.id });
}

function watchScroll() {
  let lastSent = 0;
  const report = () => {
    const percent = measureScrollProgress();
    // Held in memory for an unkept page, so a mark made at 60% does not land
    // on a record that claims you never started.
    reachedPercent = Math.max(reachedPercent, percent);
    if (!page?.id) return;
    call("REPORT_PROGRESS", {
      pageId: page.id,
      percent,
      scrollY: window.scrollY
    }).then((next) => {
      if (next) page = next;
    });
  };
  window.addEventListener(
    "scroll",
    () => {
      const now = Date.now();
      if (now - lastSent < 800) return;
      lastSent = now;
      report();
    },
    { passive: true }
  );
  report();
}

function eventFromOverlay(event) {
  return overlay.ownsEvent?.(event);
}

function watchSelection() {
  overlay.attachHosts?.();
  const finishGesture = () => {
    requestAnimationFrame(() => maybeToolbar());
    setTimeout(() => maybeToolbar(), 40);
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (eventFromOverlay(event)) return;
      gestureSelected = false;
      overlay.hideToolbar();
    },
    true
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (eventFromOverlay(event)) return;
      finishGesture();
    },
    true
  );
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      savedRange = null;
      savedRect = null;
      gestureSelected = false;
      overlay.hideToolbar();
      return;
    }
    if (event.shiftKey || event.key.startsWith("Arrow")) finishGesture();
  });
  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    gestureSelected = true;
    captureSelection(selection);
  });
}

function captureSelection(selection = window.getSelection()) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  if (selection.anchorNode && overlay.host?.contains(selection.anchorNode)) return false;
  if (selection.anchorNode && overlay.floatHost?.contains(selection.anchorNode)) return false;
  savedRange = selection.getRangeAt(0).cloneRange();
  savedRect = rangeRect(savedRange);
  return true;
}

function maybeToolbar() {
  overlay.attachHosts?.();
  if (!overlay.els?.toolbar) {
    overlay.ready.then(() => maybeToolbar()).catch(() => {});
    return;
  }
  const selection = window.getSelection();
  const liveHasRange = Boolean(selection && !selection.isCollapsed && selection.rangeCount);
  if (liveHasRange) captureSelection(selection);
  if (toolbarAction({ liveHasRange, gestureSelected, savedRange }) === "hide") {
    overlay.hideToolbar();
    return;
  }
  const rect = rangeRect(savedRange) || savedRect;
  if (!rect) return;
  savedRect = rect;
  overlay.showToolbar(rect, {
    onHighlight: (color) => createFromSelection({ color }),
    onComment: () => createFromSelection({ color: settings.defaultColor, comment: true })
  });
}

/** The first act of keeping a page is what brings its record into being. */
async function ensurePage() {
  if (page?.id) return page;
  const parsed = parseDocument(document, location.href);
  page = await call("VISIT_PAGE", {
    url: location.href,
    title: document.title,
    parsed,
    infiniteScroll: infinite.infinite
  });
  if (reachedPercent > 0) {
    const next = await call("REPORT_PROGRESS", {
      pageId: page.id,
      percent: reachedPercent,
      scrollY: window.scrollY
    });
    if (next) page = next;
  }
  overlay.setPage(page);
  return page;
}

async function createFromSelection({ color, comment = false }) {
  captureSelection();
  const range = savedRange;
  if (!range || range.collapsed) return;
  const quote = quoteFromRange(range, document.body);
  if (!quote) {
    overlay.toast("Could not read that selection. Try a longer span of text.");
    return;
  }
  try {
    await overlay.ready;
    await ensurePage();
    await anchorInfiniteView();
    const result = await call("ADD_HIGHLIGHT", {
      pageId: page.id,
      highlight: { color, text: quote.exact, prefix: quote.prefix, suffix: quote.suffix }
    });
    page = result.page;
    applyRangeHighlight(range, result.highlight);
    window.getSelection()?.removeAllRanges();
    savedRange = null;
    overlay.setPage(page);
    if (comment && result.thread) overlay.openThread(result.thread.id);
  } catch (error) {
    overlay.toast("Could not save that highlight. Reload the tab and try again.");
    console.warn("LivePage highlight", error);
  }
}

async function recolorHighlight(highlightId, color) {
  try {
    const result = await call("PATCH_HIGHLIGHT", {
      pageId: page.id,
      highlightId,
      patch: { color }
    });
    page = result.page;
    recolorMarks(highlightId, color);
    overlay.setPage(page);
  } catch (error) {
    overlay.toast("Could not change that color.");
    console.warn("LivePage recolor", error);
  }
}

async function moveHighlight(highlightId) {
  captureSelection();
  const range = savedRange;
  if (!range || range.collapsed) {
    overlay.toast("Select the new span on the page, then click Replace span.");
    return;
  }
  const quote = quoteFromRange(range, document.body);
  if (!quote) {
    overlay.toast("Could not read that selection. Try a longer span of text.");
    return;
  }
  try {
    const result = await call("PATCH_HIGHLIGHT", {
      pageId: page.id,
      highlightId,
      patch: { text: quote.exact, prefix: quote.prefix, suffix: quote.suffix }
    });
    page = result.page;
    applyRangeHighlight(range, result.highlight);
    window.getSelection()?.removeAllRanges();
    savedRange = null;
    overlay.hideToolbar();
    overlay.setPage(page);
    overlay.toast("Highlight moved to that span.");
  } catch (error) {
    overlay.toast("Could not move that highlight.");
    console.warn("LivePage move highlight", error);
  }
}

async function deleteHighlight(highlightId) {
  try {
    unwrapHighlight(document, highlightId);
    if (overlay.activeThreadId) {
      const thread = page?.threads?.find((t) => t.id === overlay.activeThreadId);
      if (!thread || thread.highlightId === highlightId) overlay.closePanel();
    }
    const result = await call("REMOVE_HIGHLIGHT", { pageId: page.id, highlightId });
    page = result.page || result;
    overlay.setPage(page);
    overlay.toast("Highlight removed.");
  } catch (error) {
    overlay.toast("Could not delete that highlight.");
    console.warn("LivePage delete highlight", error);
  }
}

function watchMarks() {
  document.addEventListener("click", (event) => {
    const mark = event.target.closest?.("mark.lp-hl");
    if (!mark) return;
    openOrCreateThread(mark.dataset.lpId);
  });
}

function openOrCreateThread(highlightId) {
  if (!page?.threads) return;
  const existing =
    page.threads.find((t) => t.highlightId === highlightId && !t.parentId) ||
    page.threads.find((t) => t.highlightId === highlightId);
  if (existing) overlay.openThread(existing.id);
}

async function sendToAgent(threadId, ask, agent) {
  try {
    const result = await call("ASK_AGENT", {
      pageId: page.id,
      threadId,
      ask,
      agent
    });
    page = result.page;
    overlay.setPage(page);
    overlay.toast(`${agent === "claude-code" ? "Claude" : "Cursor"} replied. The conversation is ready when you are.`);
  } catch (error) {
    overlay.toast("The agent could not reply. Your question is still in the conversation.");
    console.warn("LivePage agent", error);
    try {
      page = await call("GET_PAGE", { id: page.id });
      overlay.setPage(page);
    } catch {
      /* keep current page */
    }
  }
}

async function mutate(type, payload) {
  const result = await call(type, payload);
  page = result.page || result;
  overlay.setPage(page);
  return result;
}

async function refreshPage() {
  if (!page?.id) return;
  try {
    page = await call("GET_PAGE", { id: page.id });
    overlay.setPage(page);
  } catch {
    /* keep the optimistic view so the user's text is not lost */
  }
}

/**
 * A conversation is recognised by the passage it hangs off, so that leads each
 * suggestion; where it lives and how far it got are the supporting line.
 */
async function searchMentions(query) {
  const needle = String(query || "").trim().toLowerCase();
  const pages = (await call("LIST_PAGES")) || [];
  const results = [];
  for (const candidate of pages) {
    const pageTitle = candidate.title || candidate.domain || "Saved page";
    for (const thread of candidate.threads || []) {
      const messages = thread.messages || [];
      if (!messages.length) continue;
      const highlight = (candidate.highlights || []).find((item) => item.id === thread.highlightId);
      const passage = highlight?.text || messages[0].content || "";
      const haystack = `${pageTitle} ${passage} ${messages[messages.length - 1].content}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      results.push({
        pageId: candidate.id,
        threadId: thread.id,
        passage,
        pageTitle,
        samePage: candidate.id === page?.id,
        color: highlight?.color || "",
        parentId: thread.parentId || null,
        branchLabel: thread.branchLabel || "",
        messageCount: messages.length,
        updatedAt: candidate.updatedAt || 0
      });
    }
  }
  results.sort(
    (a, b) => Number(b.samePage) - Number(a.samePage) || (b.updatedAt || 0) - (a.updatedAt || 0)
  );
  return results.slice(0, 8);
}

async function openMention(pageId, threadId) {
  if (pageId === page?.id) {
    overlay.openThread(threadId);
    return;
  }
  const target = await call("GET_PAGE", { id: pageId });
  if (!target?.url) {
    overlay.toast("That referenced conversation is no longer available.");
    return;
  }
  const url = new URL(target.url);
  url.hash = `livepage-thread=${encodeURIComponent(threadId)}`;
  window.open(url.href, "_blank", "noopener");
}

function openLinkedThread() {
  const match = location.hash.match(/^#livepage-thread=([^&]+)/);
  if (!match) return;
  const threadId = decodeURIComponent(match[1]);
  if (page?.threads?.some((thread) => thread.id === threadId)) {
    overlay.openThread(threadId);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
}

function handleContext(action) {
  captureSelection();
  if (action === "comment") createFromSelection({ color: settings.defaultColor, comment: true });
  else createFromSelection({ color: settings.defaultColor || COLOR_IDS[0] });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind !== "ADD_RSS_FEED") return;
    offerRssIfAny({ force: true })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });
}

async function offerRssIfAny({ force = false } = {}) {
  const feeds = detectFeeds(document, location.href);
  if (!feeds.length) {
    if (force && overlay.els) overlay.toast("No RSS/Atom feed found on this page.");
    return;
  }
  if (!overlay.els) {
    if (force) {
      await call("ADD_RSS_FEED", { url: feeds[0].url, title: feeds[0].title });
    }
    return;
  }
  const { flags } = resolveFlags(settings);
  if (!flags.rss && !force) return;
  const known = new Set((settings.rssFeeds || []).map((feed) => feed.url));
  const feed = feeds.find((item) => !known.has(item.url)) || (force ? feeds[0] : null);
  if (!feed) return;
  overlay.offerFeed(feed, {
    onAdd: async (rawTags) => {
      const result = await call("ADD_RSS_FEED", {
        url: feed.url,
        title: feed.title,
        tags: parseTagInput(rawTags)
      });
      settings = result?.settings || (await call("GET_SETTINGS")) || settings;
      overlay.offerFeed(null);
      overlay.toast(
        result?.itemCount
          ? `Feed added. Pulled ${result.itemCount} item${result.itemCount === 1 ? "" : "s"}.`
          : "Feed added. Items will show under RSS when the feed has entries."
      );
    },
    onDismiss: () => overlay.offerFeed(null)
  });
}
