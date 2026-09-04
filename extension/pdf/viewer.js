import { call, onBroadcast } from "../shared/bridge.js";
import { Overlay } from "../content/overlay.js";
import { containerView } from "../content/view.js";
import {
  anchorHighlights,
  applyRangeHighlight,
  marksFor,
  recolorMarks
} from "../content/highlights.js";
import { rangeRect, toolbarAction } from "../content/selection.js";
import { quoteFromRange, unwrapHighlight } from "../parse/quote.js";
import { hasUsableText, linesFromItems, parsePdfDocument, titleFromUrl } from "./pdf-parse.js";
import { requestedPage, sourceUrlFrom, viewerUrlFor } from "./route.js";
import { COLOR_IDS } from "../shared/colors.js";
import { applyTheme } from "../shared/theme.js";

/**
 * LivePage's PDF reader.
 *
 * The whole point of this file is how little of it there is. A PDF gets the
 * same margin, the same colours, the same threads and the same agent as an
 * article, because it reuses the same `Overlay`, the same anchoring and the
 * same record — and a PDF's identity is its own URL, never this viewer's, so
 * everything downstream carries on as if it were a web page.
 *
 * What is genuinely different, and lives here:
 *   - the text lives in per-page layers that pdf.js destroys as you scroll
 *     away, so anchoring is a subscription rather than a boot step;
 *   - the scroller is a div, not the window, which `containerView` answers;
 *   - a highlight records which page it is on, so a restore searches one text
 *     layer instead of all of them.
 */

const FIRST_BATCH = 12;
const LATER_BATCH = 16;

const container = document.getElementById("viewerContainer");
const viewerEl = document.getElementById("viewer");
const titleEl = document.getElementById("title");
const whereEl = document.getElementById("where");
const noticeEl = document.getElementById("notice");
const loadingEl = document.getElementById("loading");

const overlay = new Overlay({ view: containerView(container) });

const sourceUrl = sourceUrlFrom(location.href);

let settings = {};
let page = null;
let parsed = null;
let pdfDocument = null;
let pdfViewer = null;
let anchors = new Map();
let pages = [];
let savedRange = null;
let savedRect = null;
let gestureSelected = false;
let reattaching = null;
let reachedPercent = 0;
let docTitle = "";
let pending = null;
let pendingTimer = null;
const sentBlocks = new Set();

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
  if (message.kind === "TOAST" && message.text) overlay.toast(message.text);
  if (message.kind === "SETTINGS_CHANGED" && message.settings) {
    settings = message.settings;
    overlay.setPreferences(settings);
    applyTheme(settings.pageTheme);
  }
});

boot().catch((error) => {
  console.warn("LivePage PDF viewer failed to start", error);
  notice(`<b>This PDF would not open.</b> ${escapeHtml(String(error?.message || error))}`);
});

async function boot() {
  bindChrome();
  watchSelection();
  watchMarks();

  if (!sourceUrl) {
    titleEl.textContent = "No PDF";
    notice("<b>No document.</b> Open a PDF from the LivePage popup, or right-click a link to one.");
    return;
  }
  if (sourceUrl.startsWith("file:") && !(await canReadFiles())) {
    titleEl.textContent = titleFromUrl(sourceUrl);
    notice(
      "<b>Chrome will not let LivePage read local files yet.</b> Open <code>chrome://extensions</code>, find LivePage, and turn on “Allow access to file URLs”. No manifest setting can ask for this on your behalf."
    );
    return;
  }

  titleEl.textContent = titleFromUrl(sourceUrl);
  progress(0);

  // The document goes first and everything else catches up. Waiting on the
  // service worker to wake and answer GET_SETTINGS before so much as asking
  // for the PDF was most of the gap between this and Chrome's own viewer.
  const opening = openDocument();

  try {
    settings = (await call("GET_SETTINGS")) || {};
    overlay.setPreferences(settings);
    applyTheme(settings.pageTheme);
  } catch {
    /* first run, before any settings exist */
  }
  overlay.ready.catch((error) => console.warn("LivePage overlay failed", error));

  await opening;
}

/* ---------------------------------------------------------------- pdf.js -- */

async function openDocument() {
  // pdf_viewer is the components build and reads the library off the global at
  // module scope, so the global has to exist before it is imported. That is
  // what the dynamic import buys us — a static one would be hoisted above it.
  const pdfjsLib = await import("../vendor/pdfjs/pdf.mjs");
  globalThis.pdfjsLib = pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = asset("vendor/pdfjs/pdf.worker.mjs");

  // Started here, before the viewer module is even imported. This is the one
  // that matters: it spawns the worker and puts the PDF on the wire while the
  // remaining quarter-megabyte of viewer code is still being evaluated.
  const task = pdfjsLib.getDocument({
    url: sourceUrl,
    withCredentials: true,
    isEvalSupported: false,
    cMapUrl: asset("vendor/pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("vendor/pdfjs/standard_fonts/")
  });
  task.onProgress = ({ loaded, total }) => progress(total ? loaded / total : 0);

  const { EventBus, PDFLinkService, PDFViewer } = await import("../vendor/pdfjs/pdf_viewer.mjs");

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 });
  pdfViewer = new PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
    // No annotation editor. LivePage's margin *is* the annotation layer, and
    // shipping pdf.js's as well would give one document two places to look for
    // one thought, only one of which is ever saved.
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    // Existing annotations still render — a paper's links should work — but
    // not as fillable form fields.
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    imageResourcesPath: asset("vendor/pdfjs/images/"),
    textLayerMode: 1
  });
  linkService.setViewer(pdfViewer);

  eventBus.on("pagesinit", () => {
    progress(1);
    pdfViewer.currentScaleValue = "page-width";
    const wanted = requestedPage(sourceUrl);
    if (wanted) pdfViewer.currentPageNumber = Math.min(wanted, pdfViewer.pagesCount);
    updateWhere();
  });

  // A text layer is built when its page comes into view and thrown away when
  // it goes far enough out of it, taking every mark in it. Restoration is
  // therefore a subscription, not something that happens once at boot.
  eventBus.on("textlayerrendered", ({ pageNumber }) => {
    restorePage(pageNumber);
    overlay.layoutCards();
    revealPending();
  });

  eventBus.on("pagechanging", () => {
    updateWhere();
    reportProgress();
  });

  pdfDocument = await task.promise;
  progress(1);
  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);

  await namePage();
  await loadRecord();
  readText().catch((error) => console.warn("LivePage PDF text", error));
}

async function namePage() {
  let fromMeta = "";
  try {
    const { info } = await pdfDocument.getMetadata();
    fromMeta = String(info?.Title || "").trim();
  } catch {
    fromMeta = "";
  }
  docTitle = fromMeta || titleFromUrl(sourceUrl);
  titleEl.textContent = docTitle;
  document.title = `${docTitle} · LivePage`;
}

/**
 * Reads the document's text and turns it into the blocks everything else
 * expects.
 *
 * The first pages are done up front so the margin, the agent and the vault
 * have something real within a second of opening; the rest follow in batches
 * so a 400-page book does not hold the reader at a blank screen. The type
 * metrics that tell a heading from a paragraph are recomputed over everything
 * read so far each time, so they get better as the document goes on rather
 * than being frozen by whatever the first twelve pages happened to look like.
 */
async function readText() {
  const total = pdfDocument.numPages;
  await extract(1, Math.min(FIRST_BATCH, total));
  await publish();

  // Answered from the opening pages rather than the whole file: a scan is a
  // scan from page one, and making the reader wait through four hundred of
  // them to be told there is nothing to select would be the worst of both.
  if (!hasUsableText(parsed)) {
    notice(
      "<b>This PDF has no text layer.</b> It is a stack of images, so there is nothing to select, quote or send to an agent. Highlighting needs text that a PDF carries; a scan does not."
    );
    return;
  }

  for (let from = FIRST_BATCH + 1; from <= total; from += LATER_BATCH) {
    // The text and the pixels share one worker. Yielding between batches keeps
    // reading the rest of a long document from stuttering the pages the reader
    // is actually looking at.
    await idle();
    await extract(from, Math.min(from + LATER_BATCH - 1, total));
    await publish();
  }
}

function idle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 60);
  });
}

async function extract(from, to) {
  for (let number = from; number <= to; number += 1) {
    try {
      const pdfPage = await pdfDocument.getPage(number);
      const content = await pdfPage.getTextContent();
      pages.push({ page: number, lines: linesFromItems(content.items) });
    } catch (error) {
      console.warn(`LivePage could not read page ${number}`, error);
    }
  }
}

/**
 * Rebuilds the parsed document from everything read so far, and stores what is
 * new in it.
 *
 * Only the blocks this batch added are sent. `mergeParsed` unions blocks by id,
 * so the record ends up with the whole document either way — but a 400-page
 * book re-sent whole on each of twenty-five batches would push megabytes
 * through the message port for no gain. The summary fields go every time
 * because they are a few hundred bytes and `mergeParsed` replaces rather than
 * merges them.
 */
async function publish() {
  parsed = parsePdfDocument({ title: docTitle, url: sourceUrl, pages });
  if (!page?.id) return;
  const fresh = parsed.blocks.filter((block) => !sentBlocks.has(block.id));
  if (!fresh.length) return;
  const next = await call("VISIT_PAGE", {
    url: sourceUrl,
    title: docTitle,
    parsed: { ...parsed, blocks: fresh },
    kind: "pdf",
    docMeta: docMeta(),
    createIfMissing: false,
    // Reading further into a document you already opened is not another visit,
    // and must not be logged as one.
    visited: false
  }).catch(() => null);
  if (!next) return;
  markSent(fresh);
  page = next;
  overlay.setPage(page);
}

function markSent(blocks) {
  for (const block of blocks) sentBlocks.add(block.id);
}

function docMeta() {
  return {
    pages: pdfDocument?.numPages || 0,
    // Recorded now, used later: this is what will let the same paper opened
    // from two different URLs be recognised as one document.
    fingerprint: pdfDocument?.fingerprints?.[0] || ""
  };
}

/* --------------------------------------------------------------- record -- */

async function loadRecord() {
  try {
    // Opening a PDF is not keeping it, exactly as opening an article is not.
    // The record appears the first time you highlight.
    page = await call("VISIT_PAGE", {
      url: sourceUrl,
      title: docTitle,
      kind: "pdf",
      docMeta: docMeta(),
      createIfMissing: false
    });
  } catch (error) {
    console.warn("LivePage visit failed", error);
    return;
  }
  if (!page) return;
  overlay.setPage(page);
  restoreVisible();
  openLinkedTarget();
}

/**
 * Opens whatever the link that brought us here was pointing at — a thread,
 * written by a mention in another page's margin, or a passage, written by the
 * dashboard's search.
 *
 * A PDF adds a step an article does not need: the passage's page may not be
 * rendered, and there is nothing to scroll to until it is. So jump to the page
 * first and let the text layer's arrival do the scrolling.
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

  const threads = (page.threads || []).filter((t) => t.highlightId === highlightId);
  const target = threads.find((t) => !t.parentId) || threads[0];
  if (target) overlay.openThread(target.id);

  const wanted = highlight.locator?.page || 0;
  if (wanted && pdfViewer) pdfViewer.currentPageNumber = Math.min(wanted, pdfViewer.pagesCount);
  wantPassage(highlightId);
}

/**
 * Waits for a passage's page to render, then scrolls to it — and gives up out
 * loud rather than leaving the reader watching a page that will never move.
 *
 * One chain only. Every text layer that renders also asks whether the passage
 * has arrived, and if each of those started its own countdown they would race
 * to declare the passage lost while another was still looking.
 */
function wantPassage(highlightId) {
  pending = highlightId;
  clearTimeout(pendingTimer);
  let attempts = 0;
  const tick = () => {
    if (!pending || revealPending()) return;
    attempts += 1;
    if (attempts >= 12) {
      overlay.toast("That passage is no longer in this document.");
      pending = null;
      return;
    }
    pendingTimer = setTimeout(tick, 250);
  };
  tick();
}

/** Scrolls to the waiting passage if its marks exist yet. */
function revealPending() {
  if (!pending) return false;
  const marks = marksFor(pending, container);
  if (!marks.length) return false;
  marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
  pending = null;
  clearTimeout(pendingTimer);
  return true;
}

/** The first act of keeping a PDF is what brings its record into being. */
async function ensurePage() {
  if (page?.id) return page;
  page = await call("VISIT_PAGE", {
    url: sourceUrl,
    title: docTitle,
    parsed,
    kind: "pdf",
    docMeta: docMeta()
  });
  // The record now holds everything read so far, so later batches only have to
  // send what comes after it.
  markSent(parsed?.blocks || []);
  if (reachedPercent > 0) {
    const next = await call("REPORT_PROGRESS", {
      pageId: page.id,
      percent: reachedPercent,
      scrollY: container.scrollTop
    });
    if (next) page = next;
  }
  overlay.setPage(page);
  return page;
}

/* -------------------------------------------------------------- anchoring -- */

function layerOf(pageNumber) {
  return container.querySelector(`.page[data-page-number="${pageNumber}"] .textLayer`);
}

function pageNumberOf(node) {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const host = el?.closest?.(".page");
  const number = Number(host?.dataset?.pageNumber);
  return Number.isFinite(number) ? number : 0;
}

function restoreVisible() {
  for (const el of container.querySelectorAll(".page")) {
    const number = Number(el.dataset.pageNumber);
    if (el.querySelector(".textLayer")) restorePage(number);
  }
  overlay.layoutCards();
}

/**
 * Puts the marks back into one page's text layer.
 *
 * The distinction that matters: a highlight that knows it lives on page 4 and
 * cannot be found there is genuinely lost, and belongs in the orphan dock. One
 * that does not know where it lives — made before locators existed, or
 * imported — proves nothing by being absent from page 4, so its failure here
 * is not recorded at all. Getting that backwards would file the reader's whole
 * library as broken the moment they opened a PDF.
 */
function restorePage(pageNumber) {
  const layer = layerOf(pageNumber);
  if (!layer || !page) return;

  const here = [];
  const homeless = [];
  for (const highlight of page.highlights || []) {
    const at = highlight.locator?.page || 0;
    if (at === pageNumber) here.push(highlight);
    else if (!at) homeless.push(highlight);
  }
  if (!here.length && !homeless.length) return;

  const verdicts = anchorHighlights(layer, [...here, ...homeless], { verdicts: anchors });
  const found = [];
  let changed = false;
  for (const [id, verdict] of verdicts) {
    const known = here.some((h) => h.id === id);
    if (!known && verdict.state === "missing") continue;
    if (anchors.get(id)?.state !== verdict.state) changed = true;
    anchors.set(id, verdict);
    if (!known && verdict.state !== "missing") found.push(id);
  }
  // setAnchors rebuilds every card. A dozen pages rendering on open would
  // otherwise rebuild the margin a dozen times to say the same thing.
  if (changed) overlay.setAnchors(anchors);
  // A highlight that turned up somewhere now knows where it lives, so the next
  // restore looks in one text layer instead of every one that renders.
  if (found.length) adoptLocators(found, pageNumber);
}

/**
 * One write at a time. Each patch reads the page, changes it and writes it
 * back, so two in flight against the same record would race and one of the two
 * locators would be lost.
 */
async function adoptLocators(highlightIds, pageNumber) {
  for (const highlightId of highlightIds) {
    try {
      const result = await call("PATCH_HIGHLIGHT", {
        pageId: page.id,
        highlightId,
        patch: { locator: { page: pageNumber } }
      });
      if (result?.page) page = result.page;
    } catch {
      /* a missing locator only costs a wider search next time */
    }
  }
}

/* -------------------------------------------------------------- selection -- */

function ownsEvent(event) {
  return overlay.ownsEvent?.(event);
}

function watchSelection() {
  const finishGesture = () => {
    requestAnimationFrame(() => maybeToolbar());
    setTimeout(() => maybeToolbar(), 40);
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (ownsEvent(event)) return;
      gestureSelected = false;
      overlay.hideToolbar();
    },
    true
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (ownsEvent(event)) return;
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
  // Crosses the shadow boundary, which `contains` does not — otherwise text
  // selected inside a margin card reads as a selection of the page.
  if (overlay.ownsNode(selection.anchorNode) || overlay.ownsNode(selection.focusNode)) return false;
  savedRange = selection.getRangeAt(0).cloneRange();
  savedRect = rangeRect(savedRange);
  return true;
}

function maybeToolbar() {
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
  if (reattaching) {
    const highlight = (page?.highlights || []).find((h) => h.id === reattaching);
    overlay.showReattachChip(rect, {
      quote: highlight?.text || "",
      known: true,
      onAttach: () => moveHighlight(reattaching),
      onCancel: () => cancelReattach()
    });
    return;
  }
  overlay.showToolbar(rect, {
    onHighlight: (color) => createFromSelection({ color }),
    onComment: () => createFromSelection({ color: settings.defaultColor || "lemon", comment: true })
  });
}

/**
 * The selection, as a page number and the text layer it sits in.
 *
 * A selection that crosses a page boundary is refused rather than silently
 * truncated. Two pages are two text layers with two coordinate systems, and
 * half a quote saved as though it were the whole one is the kind of quiet
 * wrongness that is worse than a refusal.
 */
function selectionTarget(range) {
  const start = pageNumberOf(range.startContainer);
  const end = pageNumberOf(range.endContainer);
  if (!start) return { error: "Select text inside the document." };
  if (start !== end) return { error: "A highlight has to sit on one page. Select within one." };
  const layer = layerOf(start);
  if (!layer) return { error: "That page is still rendering. Try again in a moment." };
  return { pageNumber: start, layer };
}

async function createFromSelection({ color, comment = false }) {
  captureSelection();
  const range = savedRange;
  if (!range || range.collapsed) return;
  const target = selectionTarget(range);
  if (target.error) {
    overlay.toast(target.error);
    return;
  }
  const quote = quoteFromRange(range, target.layer);
  if (!quote) {
    overlay.toast("Could not read that selection. Try a longer span of text.");
    return;
  }
  try {
    await overlay.ready;
    await ensurePage();
    const result = await call("ADD_HIGHLIGHT", {
      pageId: page.id,
      highlight: {
        color,
        text: quote.exact,
        prefix: quote.prefix,
        suffix: quote.suffix,
        locator: { page: target.pageNumber }
      }
    });
    page = result.page;
    applyRangeHighlight(range, result.highlight, target.layer);
    anchors.set(result.highlight.id, { state: "found", rung: 1, confidence: "exact" });
    window.getSelection()?.removeAllRanges();
    savedRange = null;
    overlay.setAnchors(anchors);
    overlay.setPage(page);
    if (comment && result.thread) overlay.openThread(result.thread.id);
  } catch (error) {
    overlay.toast("Could not save that highlight. Reload the tab and try again.");
    console.warn("LivePage highlight", error);
  }
}

async function recolorHighlight(highlightId, color) {
  if (!COLOR_IDS.includes(color)) return;
  try {
    const result = await call("PATCH_HIGHLIGHT", { pageId: page.id, highlightId, patch: { color } });
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
    if (anchors.get(highlightId)?.state === "missing") {
      armReattach(highlightId);
      return;
    }
    overlay.toast("Select the new span, then click Replace span.");
    return;
  }
  const target = selectionTarget(range);
  if (target.error) {
    overlay.toast(target.error);
    return;
  }
  const quote = quoteFromRange(range, target.layer);
  if (!quote) {
    overlay.toast("Could not read that selection. Try a longer span of text.");
    return;
  }
  try {
    const result = await call("PATCH_HIGHLIGHT", {
      pageId: page.id,
      highlightId,
      patch: {
        text: quote.exact,
        prefix: quote.prefix,
        suffix: quote.suffix,
        locator: { page: target.pageNumber }
      }
    });
    page = result.page;
    applyRangeHighlight(range, result.highlight, target.layer);
    window.getSelection()?.removeAllRanges();
    savedRange = null;
    overlay.hideToolbar();
    anchors.set(highlightId, { state: "found", rung: 1, confidence: "exact" });
    overlay.setAnchors(anchors);
    cancelReattach();
    overlay.setPage(page);
    overlay.toast(`Highlight moved to page ${target.pageNumber}.`);
  } catch (error) {
    overlay.toast("Could not move that highlight.");
    console.warn("LivePage move highlight", error);
  }
}

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

async function confirmAnchor(highlightId) {
  const marks = marksFor(highlightId, container);
  if (!marks.length || !page) return;
  const pageNumber = pageNumberOf(marks[0]);
  const layer = layerOf(pageNumber);
  if (!layer) return;
  const range = document.createRange();
  range.setStartBefore(marks[0]);
  range.setEndAfter(marks[marks.length - 1]);
  const quote = quoteFromRange(range, layer);
  if (!quote) return;
  try {
    const result = await call("PATCH_HIGHLIGHT", {
      pageId: page.id,
      highlightId,
      patch: {
        text: quote.exact,
        prefix: quote.prefix,
        suffix: quote.suffix,
        locator: { page: pageNumber }
      }
    });
    page = result.page;
    anchors.set(highlightId, { state: "found", rung: 1, confidence: "exact" });
    overlay.setAnchors(anchors);
    overlay.setPage(page);
    overlay.toast("Anchor confirmed.");
  } catch (error) {
    overlay.toast("Could not confirm that anchor.");
    console.warn("LivePage confirm anchor", error);
  }
}

async function deleteHighlight(highlightId) {
  try {
    unwrapHighlight(container, highlightId);
    if (overlay.activeThreadId) {
      const thread = page?.threads?.find((t) => t.id === overlay.activeThreadId);
      if (!thread || thread.highlightId === highlightId) overlay.closePanel();
    }
    const result = await call("REMOVE_HIGHLIGHT", { pageId: page.id, highlightId });
    page = result.page || result;
    anchors.delete(highlightId);
    overlay.setAnchors(anchors);
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

/* ------------------------------------------------------------- threads --- */

async function sendToAgent(threadId, ask, agent) {
  try {
    const result = await call("ASK_AGENT", { pageId: page.id, threadId, ask, agent });
    page = result.page;
    overlay.setPage(page);
    overlay.toast(
      `${agent === "claude-code" ? "Claude" : "Cursor"} replied. The conversation is ready when you are.`
    );
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
  const next = await call("GET_PAGE", { id: page.id }).catch(() => null);
  if (next) {
    page = next;
    overlay.setPage(page);
  }
}

async function searchMentions(query) {
  const rows = (await call("SEARCH_HIGHLIGHTS", { query, limit: 24 }).catch(() => [])) || [];
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
  const target = await call("GET_PAGE", { id: pageId }).catch(() => null);
  if (!target?.url) {
    overlay.toast("That referenced conversation is no longer available.");
    return;
  }
  const base = target.kind === "pdf" ? viewerUrlFor(target.url) || target.url : target.url;
  const url = new URL(base);
  url.hash = `livepage-thread=${encodeURIComponent(threadId)}`;
  window.open(url.href, "_blank", "noopener");
}

/* ---------------------------------------------------------------- chrome -- */

function bindChrome() {
  document.getElementById("dashboard").onclick = () => {
    chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  };
  document.getElementById("source").onclick = () => {
    if (sourceUrl) chrome.tabs.create({ url: sourceUrl });
  };
  document.getElementById("zoom-in").onclick = () => zoom(1.1);
  document.getElementById("zoom-out").onclick = () => zoom(1 / 1.1);
  container.addEventListener("scroll", () => overlay.hideToolbar(), { passive: true });
}

function zoom(factor) {
  if (!pdfViewer) return;
  pdfViewer.currentScale = Math.max(0.25, Math.min(6, pdfViewer.currentScale * factor));
  // The pages just changed size, so every mark moved with them.
  overlay.layoutCards();
}

/**
 * How far the download has got, 0 to 1. Anything at or past 1 puts it away.
 *
 * Servers that do not send a length leave `total` at 0, and pdf.js passes that
 * straight through — so the bar sweeps instead of claiming a proportion it
 * does not know.
 */
function progress(fraction) {
  if (!loadingEl) return;
  if (fraction >= 1) {
    loadingEl.hidden = true;
    return;
  }
  loadingEl.hidden = false;
  const bar = loadingEl.firstElementChild;
  const known = fraction > 0;
  loadingEl.classList.toggle("is-indeterminate", !known);
  if (bar && known) bar.style.width = `${Math.round(fraction * 100)}%`;
}

function updateWhere() {
  if (!pdfViewer?.pagesCount) return;
  whereEl.textContent = `${pdfViewer.currentPageNumber} / ${pdfViewer.pagesCount}`;
}

/**
 * A PDF has no scroll height worth reporting — it has a page you are on. That
 * is a better measure of "how far in" than pixels anyway, and it goes through
 * the same REPORT_PROGRESS as an article so the dashboard needs no special
 * case.
 */
function reportProgress() {
  if (!pdfViewer?.pagesCount) return;
  const percent = Math.round((pdfViewer.currentPageNumber / pdfViewer.pagesCount) * 100);
  reachedPercent = Math.max(reachedPercent, percent);
  if (!page?.id) return;
  call("REPORT_PROGRESS", {
    pageId: page.id,
    percent,
    scrollY: container.scrollTop
  })
    .then((next) => {
      if (next) page = next;
    })
    .catch(() => {
      /* progress is not worth a toast */
    });
}

async function canReadFiles() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

function asset(path) {
  return chrome.runtime.getURL(path);
}

function notice(html) {
  noticeEl.innerHTML = html;
  noticeEl.hidden = false;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
