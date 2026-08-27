import {
  deletePage,
  getLedger,
  getPage,
  getPageByUrl,
  getSettings,
  listPages,
  newHighlight,
  newMessage,
  newThread,
  putPage,
  saveLedger,
  saveSettings,
  searchPages,
  unreadPages,
  upsertImportedPages,
  upsertPageFromVisit,
  getMind,
  saveMind,
  recordEvent,
  listEvents
} from "../storage/store.js";
import { buildAgentPacket, nextLedger } from "../agent/packet.js";
import { obsidianNewUri, pageToMarkdown, suggestedFilename } from "../export/obsidian.js";
import { canonicalizeUrl, pageIdFromUrl } from "../shared/url.js";
import { applyProgress } from "../shared/progress.js";
import { uniqueItems } from "../import/normalize.js";
import { syncSaves } from "../import/sync.js";
import { applyTweetReaction } from "../feed/local-tweets.js";

export async function handleMessage(message) {
  const type = message?.type;
  const payload = message?.payload || {};
  switch (type) {
    case "GET_SETTINGS":
      return getSettings();
    case "SAVE_SETTINGS":
      return saveSettings(payload);
    case "VISIT_PAGE": {
      const page = await upsertPageFromVisit(payload.url, payload);
      await note("open", { pageId: page.id, source: page.importMeta?.source });
      return page;
    }
    case "GET_PAGE":
      return payload.id ? getPage(payload.id) : getPageByUrl(payload.url);
    case "LIST_PAGES":
      return listPages();
    case "SEARCH_PAGES":
      return searchPages(payload.query);
    case "UNREAD_PAGES":
      return unreadPages();
    case "SAVE_PAGE":
      return putPage(payload.page);
    case "PATCH_PAGE":
      return patchPage(payload.id || pageIdFromUrl(canonicalizeUrl(payload.url)), payload.patch);
    case "DELETE_PAGE":
      await deletePage(payload.id);
      return { ok: true };
    case "SET_READ_STATE":
      return patchPage(payload.id, { readState: payload.readState });
    case "TOGGLE_BOOKMARK":
      return toggleBookmark(payload.id);
    case "ADD_HIGHLIGHT":
      return addHighlight(payload);
    case "REMOVE_HIGHLIGHT":
      return removeHighlight(payload.pageId, payload.highlightId);
    case "ADD_MESSAGE":
      return addMessage(payload);
    case "FORK_THREAD":
      return forkThread(payload);
    case "SET_THREAD_STATUS":
      return setThreadStatus(payload);
    case "BUILD_AGENT_PACKET":
      return makePacket(payload);
    case "RESET_LEDGER":
      return saveLedger({
        pageId: payload.pageId,
        sentBlockIds: [],
        sentHighlightIds: [],
        sentThreadIds: [],
        lastSentAt: 0
      });
    case "EXPORT_OBSIDIAN":
      return exportObsidian(payload.id);
    case "SNAPSHOT_PAGE":
      return snapshotPage(payload);
    case "REPORT_PROGRESS":
      return reportProgress(payload);
    case "IMPORT_ITEMS":
      return upsertImportedPages(uniqueItems(payload.items || []));
    case "SYNC_SAVES":
      return syncSaves({
        openTabs: Boolean(payload.openTabs),
        importItems: upsertImportedPages
      });
    case "SNOOZE_PAGE": {
      const page = await patchPage(payload.id, {
        snoozedUntil: Date.now() + (payload.hours || 48) * 60 * 60 * 1000
      });
      await note("snooze", { pageId: page.id, source: page.importMeta?.source });
      return page;
    }
    case "GET_MIND":
      return getMind();
    case "LIST_EVENTS":
      return listEvents();
    case "RECORD_EVENT":
      return recordEvent(payload);
    case "REACT_TWEET":
      return reactTweet(payload);
    default:
      throw new Error(`Unknown message: ${type}`);
  }
}

async function patchPage(id, patch) {
  const page = await getPage(id);
  if (!page) throw new Error("Page not found");
  Object.assign(page, patch);
  return putPage(page);
}

async function toggleBookmark(id) {
  const page = await getPage(id);
  if (!page) throw new Error("Page not found");
  page.bookmarked = !page.bookmarked;
  return putPage(page);
}

async function addHighlight(payload) {
  const page = await loadPage(payload);
  const highlight = newHighlight(payload.highlight || payload);
  const thread = newThread({
    highlightId: highlight.id,
    status: payload.status || "open",
    messages: payload.comment
      ? [newMessage({ role: "user", content: payload.comment })]
      : []
  });
  highlight.threadId = thread.id;
  page.threads.push(thread);
  page.highlights.push(highlight);
  if (page.readState === "unread") page.readState = "in_progress";
  await putPage(page);
  return { page, highlight, thread };
}

async function removeHighlight(pageId, highlightId) {
  const page = await getPage(pageId);
  if (!page) throw new Error("Page not found");
  page.highlights = page.highlights.filter((h) => h.id !== highlightId);
  page.threads = page.threads.filter((t) => t.highlightId !== highlightId);
  await putPage(page);
  return page;
}

async function addMessage(payload) {
  const page = await loadPage(payload);
  const thread = page.threads.find((t) => t.id === payload.threadId);
  if (!thread) throw new Error("Thread not found");
  const message = newMessage(payload.message || payload);
  if (!message.content) throw new Error("Empty message");
  thread.messages.push(message);
  if (payload.status) thread.status = payload.status;
  await putPage(page);
  return { page, thread, message };
}

async function forkThread(payload) {
  const page = await loadPage(payload);
  const source = page.threads.find((t) => t.id === payload.threadId);
  if (!source) throw new Error("Thread not found");
  const cut = payload.messageId
    ? source.messages.findIndex((m) => m.id === payload.messageId)
    : source.messages.length - 1;
  const kept = cut >= 0 ? source.messages.slice(0, cut + 1) : source.messages.slice();
  const branch = newThread({
    highlightId: source.highlightId,
    parentId: source.id,
    forkedFromMessageId: payload.messageId || kept[kept.length - 1]?.id,
    branchLabel: payload.branchLabel || nextBranchLabel(page, source),
    status: "open",
    messages: kept.map((m) => ({ ...m }))
  });
  if (payload.comment) {
    branch.messages.push(newMessage({ role: "user", content: payload.comment }));
  }
  page.threads.push(branch);
  await putPage(page);
  return { page, thread: branch };
}

function nextBranchLabel(page, source) {
  const siblings = page.threads.filter(
    (t) => t.parentId === source.id || t.id === source.id
  );
  return `branch-${siblings.length}`;
}

async function setThreadStatus(payload) {
  const page = await loadPage(payload);
  const thread = page.threads.find((t) => t.id === payload.threadId);
  if (!thread) throw new Error("Thread not found");
  thread.status = payload.status;
  await putPage(page);
  return { page, thread };
}

async function makePacket(payload) {
  const page = await loadPage(payload);
  const thread = page.threads.find((t) => t.id === payload.threadId);
  if (!thread) throw new Error("Thread not found");
  const ledger = await getLedger(page.id);
  const packet = buildAgentPacket({
    page,
    thread,
    ask: payload.ask,
    ledger,
    agent: payload.agent
  });
  if (payload.commit !== false) {
    await saveLedger(nextLedger(ledger, packet, page.id));
  }
  if (payload.ask && payload.recordAsk !== false) {
    thread.messages.push(
      newMessage({
        role: "user",
        content: payload.ask
      })
    );
    await putPage(page);
  }
  return { packet, page, thread };
}

async function exportObsidian(id) {
  const page = await getPage(id);
  if (!page) throw new Error("Page not found");
  const settings = await getSettings();
  const markdown = pageToMarkdown(page);
  const filename = suggestedFilename(page);
  const uri = obsidianNewUri({
    vault: settings.obsidianVault,
    folder: settings.obsidianFolder,
    filename,
    content: markdown
  });
  return { markdown, filename, uri, folder: settings.obsidianFolder };
}

async function snapshotPage(payload) {
  const page = await loadPage(payload);
  page.snapshot = {
    at: Date.now(),
    contentHash: page.parsed?.contentHash || "",
    blockIds: (page.parsed?.blocks || []).map((b) => b.id)
  };
  page.infiniteScroll = true;
  await putPage(page);
  return page;
}

async function reportProgress(payload) {
  const page = await loadPage(payload);
  const before = page.progress?.maxPercent || 0;
  applyProgress(page, payload.percent, payload.scrollY || 0);
  const after = page.progress.maxPercent;
  const saved = await putPage(page);
  const mind = await getMind();
  if (mind.lastAct?.pageId === page.id && after > before + 7) {
    const next = applyTweetReaction(mind, {
      signal: mind.lastAct.signal,
      reaction: "conversion"
    });
    next.lastAct = { ...mind.lastAct, converted: true };
    await saveMind(next);
    await note("conversion", { pageId: page.id, signal: mind.lastAct.signal });
  }
  if (after >= 90 && before < 90) {
    await note("read_through", { pageId: page.id });
  }
  return saved;
}

async function reactTweet(payload) {
  const mind = await getMind();
  const next = applyTweetReaction(mind, {
    signal: payload.signal,
    reaction: payload.reaction,
    now: Date.now()
  });
  if (payload.reaction === "act") {
    next.lastAct = {
      signal: payload.signal,
      pageId: payload.pageId || null,
      at: Date.now()
    };
  }
  await saveMind(next);
  await note(`tweet_${payload.reaction}`, {
    pageId: payload.pageId,
    signal: payload.signal
  });
  return next;
}

async function note(kind, extra = {}) {
  try {
    await recordEvent({ kind, ...extra });
  } catch {
    /* first-run stores */
  }
}

async function loadPage(payload) {
  if (payload.page) return payload.page;
  if (payload.pageId) {
    const page = await getPage(payload.pageId);
    if (!page) throw new Error("Page not found");
    return page;
  }
  if (payload.url) {
    const page = await getPageByUrl(payload.url);
    if (!page) throw new Error("Page not found");
    return page;
  }
  throw new Error("pageId or url required");
}
