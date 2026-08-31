import { call, onBroadcast } from "../shared/bridge.js";
import { parseDocument } from "../parse/page-parser.js";
import {
  createInfiniteScrollDetector,
  evaluateInfiniteScroll
} from "../parse/infinite-scroll.js";
import { quoteFromRange, unwrapHighlight } from "../parse/quote.js";
import {
  applyRangeHighlight,
  restoreHighlights,
  selectionIsSafe,
  recolorMarks
} from "./highlights.js";
import { Overlay } from "./overlay.js";
import { toolbarAction, rangeRect } from "./selection.js";
import { COLOR_IDS } from "../shared/colors.js";
import { measureScrollProgress } from "../shared/progress.js";
import { detectFeeds } from "../import/rss.js";
import { parseTagInput } from "../shared/tags.js";
import { resolveFlags } from "../shared/flags.js";

if (globalThis.__LP_CONTENT_STARTED) {
  throw new Error("LivePage content already started");
}
globalThis.__LP_CONTENT_STARTED = true;

const overlay = new Overlay();
let page = null;
let settings = { defaultColor: "lemon", lockInfiniteScroll: true, allowInfiniteSnapshot: true };
let infinite = { infinite: false, reason: null };
let snapshotMode = false;
let savedRange = null;
let savedRect = null;
let gestureSelected = false;

overlay.handlers = {
  onSnapshot: () => snapshot(),
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
  onDeleteHighlight: (highlightId) => deleteHighlight(highlightId)
};

onBroadcast((message) => {
  if (message.kind === "CONTEXT_ACTION") handleContext(message.action);
  if (message.kind === "TOAST" && message.text) overlay.toast(message.text);
});
boot().catch((error) => console.warn("LivePage failed to start", error));

async function boot() {
  infinite = evaluateInfiniteScroll(location.href, document);
  watchSelection();
  watchMarks();

  try {
    settings = (await call("GET_SETTINGS")) || settings;
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
    page = await call("VISIT_PAGE", {
      url: location.href,
      title: document.title,
      parsed,
      infiniteScroll: infinite.infinite
    });
    if (page.snapshot) snapshotMode = true;
    restoreHighlights(document.body, page.highlights);
    overlay.setPage(page);
    applyLock();
    watchInfinite();
    watchScroll();
  } catch (error) {
    console.warn("LivePage visit failed", error);
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
    call("PATCH_PAGE", { id: page.id, patch: { infiniteScroll: true } });
    applyLock();
  });
  detector.start();
}

function applyLock() {
  const shouldLock = Boolean(
    settings.lockInfiniteScroll && infinite.infinite && !snapshotMode
  );
  overlay.setLock({
    locked: shouldLock,
    reason: infinite.reason,
    snapshotTexts: snapshotMode ? (page.parsed?.blocks || []).map((b) => b.text) : null
  });
}

async function snapshot() {
  const parsed = parseDocument(document, location.href);
  page = await call("PATCH_PAGE", { id: page.id, patch: { parsed, infiniteScroll: true } });
  page = await call("SNAPSHOT_PAGE", { pageId: page.id });
  snapshotMode = true;
  overlay.setPage(page);
  applyLock();
  overlay.toast("Snapshot taken. You can annotate this view.");
}

function watchScroll() {
  let lastSent = 0;
  const report = () => {
    if (!page?.id) return;
    const percent = measureScrollProgress();
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
  const locked = settings.lockInfiniteScroll && infinite.infinite && !snapshotMode;
  if (locked) {
    overlay.showToolbar(rect, {
      onSnapshot: () => overlay.handlers.onSnapshot?.()
    });
    return;
  }
  if (snapshotMode && liveHasRange && !selectionIsSafe(selection, (page?.parsed?.blocks || []).map((b) => b.text))) {
    overlay.toast("That span arrived after the snapshot. Ignore or snapshot again.");
    overlay.hideToolbar();
    return;
  }
  overlay.showToolbar(rect, {
    onHighlight: (color) => createFromSelection({ color }),
    onComment: () => createFromSelection({ color: settings.defaultColor, comment: true })
  });
}

async function ensurePage() {
  if (page?.id) return page;
  const parsed = parseDocument(document, location.href);
  page = await call("VISIT_PAGE", {
    url: location.href,
    title: document.title,
    parsed,
    infiniteScroll: infinite.infinite
  });
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
    overlay.toast("Asking the agent…");
    const result = await call("ASK_AGENT", {
      pageId: page.id,
      threadId,
      ask,
      agent
    });
    page = result.page;
    overlay.setPage(page);
    overlay.openThread(result.thread.id);
    overlay.toast("Reply landed in the thread.");
  } catch (error) {
    overlay.toast(String(error.message || error));
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
  if (result.thread) overlay.openThread(result.thread.id);
  return result;
}

function handleContext(action) {
  if (settings.lockInfiniteScroll && infinite.infinite && !snapshotMode) {
    overlay.toast("Snapshot this page before highlighting. Infinite pages cannot keep stable anchors.");
    return;
  }
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
