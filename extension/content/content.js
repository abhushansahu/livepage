import { call, onBroadcast } from "../shared/bridge.js";
import { parseDocument } from "../parse/page-parser.js";
import {
  createInfiniteScrollDetector,
  evaluateInfiniteScroll
} from "../parse/infinite-scroll.js";
import { quoteFromRange } from "../parse/quote.js";
import {
  applyRangeHighlight,
  restoreHighlights,
  selectionIsSafe
} from "./highlights.js";
import { Overlay } from "./overlay.js";
import { COLOR_IDS } from "../shared/colors.js";
import { measureScrollProgress } from "../shared/progress.js";
import { harvestDocument, classifyLibraryUrl, sourceForHost } from "../import/harvest.js";
import { fetchRedditSaved, fetchYoutubeWatchLater } from "../import/fetchers.js";
import { uniqueItems } from "../import/normalize.js";

const overlay = new Overlay();
let page = null;
let settings = { defaultColor: "lemon", lockInfiniteScroll: true, allowInfiniteSnapshot: true };
let infinite = { infinite: false, reason: null };
let snapshotMode = false;
let savedRange = null;

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
    })
};

boot().catch((error) => console.warn("LivePage failed to start", error));
listenForHarvest();

async function boot() {
  settings = (await call("GET_SETTINGS")) || settings;
  const library = classifyLibraryUrl(location.href);
  const source = sourceForHost(location.href);
  if (settings.importSavesEnabled !== false && (library || source?.id === "reddit" || source?.id === "youtube")) {
    pushSaves().catch(() => {});
    if (library) watchLibraryGrowth();
  }
  if (library) return;

  await overlay.ready;
  const parsed = parseDocument(document, location.href);
  const hostGuess = evaluateInfiniteScroll(location.href, document);
  infinite = hostGuess;
  page = await call("VISIT_PAGE", {
    url: location.href,
    title: document.title,
    parsed,
    infiniteScroll: hostGuess.infinite
  });
  if (page.snapshot) snapshotMode = true;
  restoreHighlights(document.body, page.highlights);
  overlay.setPage(page);
  applyLock();
  watchSelection();
  watchMarks();
  watchInfinite();
  watchScroll();
  onBroadcast((message) => {
    if (message.kind === "CONTEXT_ACTION") handleContext(message.action);
  });
  document.documentElement.classList.add("lp-rail-on");
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

function watchSelection() {
  document.addEventListener("mouseup", () => {
    requestAnimationFrame(() => maybeToolbar());
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") overlay.hideToolbar();
  });
}

function maybeToolbar() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    overlay.hideToolbar();
    savedRange = null;
    return;
  }
  if (selection.anchorNode && overlay.host.contains(selection.anchorNode)) return;
  const locked = settings.lockInfiniteScroll && infinite.infinite && !snapshotMode;
  if (locked) {
    overlay.hideToolbar();
    overlay.toast("Snapshot this page before highlighting. Infinite pages cannot keep stable anchors.");
    return;
  }
  if (snapshotMode && !selectionIsSafe(selection, (page.parsed?.blocks || []).map((b) => b.text))) {
    overlay.toast("That span arrived after the snapshot. Ignore or snapshot again.");
    overlay.hideToolbar();
    return;
  }
  const range = selection.getRangeAt(0);
  savedRange = range.cloneRange();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  overlay.showToolbar(rect, {
    onHighlight: (color) => createFromSelection({ color }),
    onComment: () => createFromSelection({ color: settings.defaultColor, comment: true })
  });
}

async function createFromSelection({ color, comment = false }) {
  const range = savedRange;
  if (!range || range.collapsed) return;
  const quote = quoteFromRange(range, document.body);
  if (!quote) return;
  if (!page.why) {
    const why = prompt("Why this page? Optional — helps later-you reactivate.") || "";
    if (why) {
      page = await call("PATCH_PAGE", { id: page.id, patch: { why } });
    }
  }
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
}

function watchMarks() {
  document.addEventListener("click", (event) => {
    const mark = event.target.closest?.("mark.lp-hl");
    if (!mark) return;
    openOrCreateThread(mark.dataset.lpId);
  });
}

function openOrCreateThread(highlightId) {
  const existing =
    page.threads.find((t) => t.highlightId === highlightId && !t.parentId) ||
    page.threads.find((t) => t.highlightId === highlightId);
  if (existing) overlay.openThread(existing.id);
}

async function sendToAgent(threadId, ask, agent) {
  const result = await call("BUILD_AGENT_PACKET", {
    pageId: page.id,
    threadId,
    ask,
    agent
  });
  page = result.page;
  overlay.setPage(page);
  overlay.openThread(result.thread.id);
  try {
    await navigator.clipboard.writeText(result.packet.markdown);
    overlay.toast(
      agent === "claude-code"
        ? "Packet copied. Paste Claude’s reply here and send."
        : "Packet copied. Paste Cursor’s reply here and send."
    );
  } catch {
    overlay.toast("Could not copy automatically. Packet is in the dashboard export.");
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
  if (action === "comment") createFromSelection({ color: settings.defaultColor, comment: true });
  else createFromSelection({ color: settings.defaultColor || COLOR_IDS[0] });
}

let harvestTimer = 0;

function listenForHarvest() {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind !== "HARVEST_SAVES") return;
    collectSaves()
      .then((items) => sendResponse({ ok: true, items }))
      .catch(() => sendResponse({ ok: false, items: [] }));
    return true;
  });
}

async function collectSaves() {
  if (settings.importSavesEnabled === false) return [];
  const library = classifyLibraryUrl(location.href);
  const source = sourceForHost(location.href);
  const fromDom = library ? harvestDocument(document, location.href) : [];
  let fromApi = [];
  if (source?.id === "reddit") fromApi = (await fetchRedditSaved()).items || [];
  if (source?.id === "youtube") fromApi = (await fetchYoutubeWatchLater()).items || [];
  return uniqueItems([...fromDom, ...fromApi]);
}

async function pushSaves() {
  const items = await collectSaves();
  if (items.length) await call("IMPORT_ITEMS", { items });
  return items;
}

function watchLibraryGrowth() {
  const observer = new MutationObserver(() => {
    clearTimeout(harvestTimer);
    harvestTimer = setTimeout(() => {
      pushSaves().catch(() => {});
    }, 1600);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
