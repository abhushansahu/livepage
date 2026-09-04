import { call, onBroadcast } from "../shared/bridge.js";
import { parseDocument } from "../parse/page-parser.js";
import {
  createInfiniteScrollDetector,
  evaluateInfiniteScroll
} from "../parse/infinite-scroll.js";
import { quoteFromRange, unwrapHighlight } from "../parse/quote.js";
import {
  anchorHighlights,
  applyRangeHighlight,
  marksFor,
  recolorMarks,
  selectionIsSafe
} from "./highlights.js";
import { createReanchorLoop, watchUrl } from "./reanchor.js";
import { Overlay } from "./overlay.js";
import { toolbarAction, rangeRect } from "./selection.js";
import { COLOR_IDS } from "../shared/colors.js";
import { measureScrollProgress } from "../shared/progress.js";
import { detectFeeds } from "../import/rss.js";
import { parseTagInput } from "../shared/tags.js";
import { resolveFlags } from "../shared/flags.js";
import { canonicalizeUrl, pageIdFromUrl } from "../shared/url.js";
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
let anchorFlag = true;
let anchors = new Map();
let anchorTimer = null;
let reanchor = null;
let stopInfinite = null;
let stopUrlWatch = null;
let reattaching = null;
let symbols = null;
let symbolLoop = null;
let symbolsFlag = false;

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
  onConfirmAnchor: (highlightId) => confirmAnchor(highlightId),
  onCancelReattach: () => cancelReattach(),
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
  anchorFlag = flags.orphanRecovery !== false;
  symbolsFlag = Boolean(flags.articleSymbols);

  try {
    await overlay.ready;
  } catch (error) {
    console.warn("LivePage overlay failed", error);
  }
  maybeToolbar();

  const parsed = freshParse();
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
      anchorNow();
      overlay.setPage(page);
      openLinkedTarget();
      if (anchorFlag) reanchor = startReanchor();
    }
    watchInfinite();
    watchScroll();
    if (anchorFlag) watchNavigation();
  } catch (error) {
    console.warn("LivePage visit failed", error);
  }
  if (symbolsFlag && !mountSymbols(parsed)) startSymbolLoop();
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
  stopInfinite = detector.start();
}

/**
 * Re-reads the page and records what became of every highlight's quote.
 *
 * Highlights that already anchored are left in place; only the unresolved ones
 * are looked for again, so a retry costs one pass over the document rather
 * than a full teardown of every mark on it.
 */
function anchorNow() {
  if (!page) return;
  anchors = anchorHighlights(document.body, page.highlights, { verdicts: anchors });
  if (anchorFlag) {
    overlay.setAnchors(anchors);
    queueAnchorReport();
  }
}

function unresolvedCount() {
  let count = 0;
  for (const result of anchors.values()) {
    if (result.state === "missing") count += 1;
  }
  return count;
}

function startReanchor() {
  const loop = createReanchorLoop({
    root: document.body,
    unresolvedCount,
    infinite: infinite.infinite,
    // anchorNow re-renders the margin through setAnchors, which lays the cards
    // out against wherever the marks ended up.
    anchorNow
  });
  loop.start();
  return loop;
}

/**
 * Tells the record what the live page did with each quote — once per load,
 * after the retries have settled, and never when nothing changed.
 */
function queueAnchorReport() {
  if (!page?.id || !anchors.size) return;
  if (anchorTimer) clearTimeout(anchorTimer);
  anchorTimer = setTimeout(flushAnchorReport, 2000);
}

async function flushAnchorReport() {
  if (anchorTimer) clearTimeout(anchorTimer);
  anchorTimer = null;
  if (!page?.id || !anchors.size) return;
  const verdicts = [...anchors.entries()].map(([highlightId, result]) => ({
    highlightId,
    state: result.state,
    rung: result.rung || 0
  }));
  try {
    const result = await call("REPORT_ANCHORS", {
      pageId: page.id,
      url: location.href,
      verdicts
    });
    if (result?.page) page = result.page;
  } catch (error) {
    console.warn("LivePage anchor report failed", error);
  }
}

/**
 * Paints the terms worth explaining, and keeps trying while the page arrives.
 *
 * A client-rendered page has no article at document_idle, and symbols used to
 * get exactly one look at it. They now retry on the same schedule the
 * highlights do, and are torn down and rebuilt when a single-page app swaps
 * the article underneath.
 */
function mountSymbols(parsed) {
  try {
    symbols?.destroy();
  } catch (error) {
    console.warn("LivePage article symbols teardown failed", error);
  }
  symbols = null;
  try {
    symbols = enableArticleSymbols(document, parsed, {
      call,
      pageTitle: document.title,
      url: location.href,
      prefetch: Boolean(page)
    });
  } catch (error) {
    console.warn("LivePage article symbols failed", error);
  }
  return symbols?.count || 0;
}

function startSymbolLoop() {
  symbolLoop?.stop();
  symbolLoop = createReanchorLoop({
    root: document.body,
    // Nothing painted yet is the only thing worth waiting for; once a term is
    // on the page the article has arrived.
    unresolvedCount: () => (symbols?.count ? 0 : 1),
    infinite: infinite.infinite,
    anchorNow: () => mountSymbols(freshParse())
  });
  symbolLoop.start();
}

function freshParse() {
  try {
    return parseDocument(document, location.href);
  } catch (error) {
    console.warn("LivePage parse failed", error);
    return { blocks: [] };
  }
}

/**
 * A single-page app swaps articles without ever reloading, so highlights have
 * to be re-read — and the old page's marks and progress have to be let go, or
 * one article's notes bleed onto the next.
 */
function watchNavigation() {
  if (stopUrlWatch) stopUrlWatch();
  stopUrlWatch = watchUrl(async () => {
    const sameDocument = page && samePageId(page, location.href);
    if (sameDocument) {
      reanchor?.kick();
      return;
    }
    await flushAnchorReport();
    reanchor?.stop();
    reanchor = null;
    if (stopInfinite) stopInfinite();
    stopInfinite = null;
    for (const highlight of page?.highlights || []) {
      unwrapHighlight(document, highlight.id);
    }
    symbolLoop?.stop();
    symbolLoop = null;
    try {
      symbols?.destroy();
    } catch (error) {
      console.warn("LivePage article symbols teardown failed", error);
    }
    symbols = null;
    anchors = new Map();
    page = null;
    reachedPercent = 0;
    savedRange = null;
    savedRect = null;
    cancelReattach();
    overlay.closePanel();
    overlay.clear();
    await revisit();
  });
}

function samePageId(current, href) {
  try {
    return current.id === pageIdFromUrl(canonicalizeUrl(href));
  } catch {
    return false;
  }
}

async function revisit() {
  const parsed = freshParse();
  infinite = evaluateInfiniteScroll(location.href, document);
  try {
    page = await call("VISIT_PAGE", {
      url: location.href,
      title: document.title,
      parsed,
      infiniteScroll: infinite.infinite,
      createIfMissing: false
    });
  } catch (error) {
    console.warn("LivePage visit failed", error);
    return;
  }
  if (page) {
    anchorNow();
    overlay.setPage(page);
    if (anchorFlag) reanchor = startReanchor();
  }
  watchInfinite();
  if (symbolsFlag && !mountSymbols(parsed)) startSymbolLoop();
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
      cancelReattach();
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
  // While a re-attach is armed the selection means one thing only: this is
  // where that highlight belongs now. Offer that instead of a new highlight.
  if (reattaching) {
    const highlight = (page?.highlights || []).find((h) => h.id === reattaching);
    overlay.showReattachChip(rect, {
      quote: highlight?.text || "",
      known: reattachTargetIsKnown(),
      onAttach: () => moveHighlight(reattaching),
      onCancel: () => cancelReattach()
    });
    return;
  }
  overlay.showToolbar(rect, {
    onHighlight: (color) => createFromSelection({ color }),
    onComment: () => createFromSelection({ color: settings.defaultColor, comment: true })
  });
}

/**
 * Whether the selected text appears anywhere in the copy we have saved of this
 * page. Only ever a remark on the chip — the page changing is exactly the
 * situation a re-attach is for, so this must not block one.
 */
function reattachTargetIsKnown() {
  const blocks = (page?.parsed?.blocks || []).map((block) => block.text);
  if (!blocks.length) return true;
  return selectionIsSafe(window.getSelection(), blocks);
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
    // An orphan's passage is somewhere else on the page and its card scrolls
    // out of reach, so "select first, then click" cannot be completed. Arm
    // instead, and wait for the selection.
    if (anchorFlag && anchors.get(highlightId)?.state === "missing") {
      armReattach(highlightId);
      return;
    }
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
    anchors.set(highlightId, { state: "found", rung: 1, confidence: "exact" });
    overlay.setAnchors(anchors);
    cancelReattach();
    overlay.setPage(page);
    overlay.toast("Highlight moved to that span.");
  } catch (error) {
    overlay.toast("Could not move that highlight.");
    console.warn("LivePage move highlight", error);
  }
}

/**
 * Waits for the reader to point at the passage. Nothing is committed until
 * they confirm the chip, so a stray selection cannot move a highlight.
 */
function armReattach(highlightId) {
  reattaching = highlightId;
  overlay.setReattaching(highlightId);
  overlay.toast("Select the passage this belongs to now.");
}

function cancelReattach() {
  if (!reattaching) return;
  reattaching = null;
  overlay.setReattaching(null);
  overlay.hideToolbar();
}

/**
 * A loose match restored, and the reader says it is the right passage. Rewrite
 * the stored quote from where it actually sits, so the next load matches
 * cleanly instead of drifting further from a quote that is already stale.
 */
async function confirmAnchor(highlightId) {
  const marks = marksFor(highlightId);
  if (!marks.length || !page) return;
  const range = document.createRange();
  range.setStartBefore(marks[0]);
  range.setEndAfter(marks[marks.length - 1]);
  const quote = quoteFromRange(range, document.body);
  if (!quote) return;
  try {
    const result = await call("PATCH_HIGHLIGHT", {
      pageId: page.id,
      highlightId,
      patch: { text: quote.exact, prefix: quote.prefix, suffix: quote.suffix }
    });
    page = result.page;
    anchors.set(highlightId, { state: "found", rung: 1, confidence: "exact" });
    overlay.setAnchors(anchors);
    anchorNow();
    overlay.setPage(page);
    overlay.toast("Anchor confirmed.");
  } catch (error) {
    overlay.toast("Could not confirm that anchor.");
    console.warn("LivePage confirm anchor", error);
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
/**
 * Conversations worth referencing from this composer.
 *
 * The search itself runs where the records already are. Pulling every page
 * into the content script on each keystroke was the old way, and it scaled
 * with the size of the library rather than the size of the answer.
 */
async function searchMentions(query) {
  const rows = (await call("SEARCH_HIGHLIGHTS", { query, limit: 24 })) || [];
  return rows
    .filter((row) => row.threadId && row.messageCount)
    .map((row) => ({
      pageId: row.page.id,
      threadId: row.threadId,
      passage: row.text || row.snippet?.text || "",
      pageTitle: row.page.title || row.page.domain || "Saved page",
      samePage: row.page.id === page?.id,
      color: row.color || "",
      parentId: row.parentId,
      branchLabel: row.branchLabel,
      messageCount: row.messageCount,
      updatedAt: row.page.updatedAt || 0
    }))
    .sort(
      (a, b) => Number(b.samePage) - Number(a.samePage) || (b.updatedAt || 0) - (a.updatedAt || 0)
    )
    .slice(0, 8);
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

/**
 * Opens whatever the link that brought us here was pointing at.
 *
 * Two forms: a thread, written by a mention in another page's margin, and a
 * highlight, written by passage search — which knows the passage but not which
 * of its branches you wanted.
 */
function openLinkedTarget() {
  const hash = location.hash;
  const clean = () => history.replaceState(null, "", `${location.pathname}${location.search}`);

  const thread = hash.match(/^#livepage-thread=([^&]+)/);
  if (thread) {
    const threadId = decodeURIComponent(thread[1]);
    if (page?.threads?.some((t) => t.id === threadId)) {
      overlay.openThread(threadId);
      clean();
    }
    return;
  }

  const passage = hash.match(/^#livepage-highlight=([^&]+)/);
  if (!passage) return;
  const highlightId = decodeURIComponent(passage[1]);
  const highlight = page?.highlights?.find((h) => h.id === highlightId);
  if (!highlight) return;
  clean();
  const marks = marksFor(highlightId);
  if (!marks.length) {
    // The passage is gone from the page, so there is nothing to scroll to. It
    // will be waiting in the orphan dock instead.
    overlay.toast("That passage is no longer on this page.");
  } else {
    marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const threads = (page.threads || []).filter((t) => t.highlightId === highlightId);
  const target = threads.find((t) => !t.parentId) || threads[0];
  if (target) overlay.openThread(target.id);
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
