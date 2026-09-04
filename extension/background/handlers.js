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
  searchHighlights,
  getMarkup,
  putMarkup,
  deleteMarkup,
  unreadPages,
  upsertImportedPages,
  upsertPageFromVisit,
  getMind,
  saveMind,
  getGloss,
  listGlossary,
  putGloss,
  recordEvent,
  listEvents
} from "../storage/store.js";
import {
  buildAgentPacket,
  buildSymbolExplainPacket,
  glossText,
  nextLedger
} from "../agent/packet.js";
import { pairAgentHost, pingAgentHost, runAgentAsk } from "../agent/host-client.js";
import {
  anchorMarkup,
  articleIsWorthMarking,
  buildMarkupPacket,
  markCeiling,
  parseMarkupReply
} from "../agent/markup.js";
import { obsidianNewUri, pageToMarkdown, suggestedFilename } from "../export/obsidian.js";
import { canonicalizeUrl, pageIdFromUrl } from "../shared/url.js";
import { mergeAnchorVerdict } from "../shared/anchors.js";
import { applyProgress } from "../shared/progress.js";
import { isKept } from "../shared/lists.js";
import { uniqueItems } from "../import/normalize.js";
import { syncSaves } from "../import/sync.js";
import { parseRssUrlInput, syncRssFeeds } from "../import/rss.js";
import { applyTweetReaction } from "../feed/local-tweets.js";
import { mergeTags, parseTagInput } from "../shared/tags.js";
import { uid } from "../shared/id.js";
import { resolveFlags } from "../shared/flags.js";
import { COLOR_IDS } from "../shared/colors.js";

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
      if (!page) return null;
      await note("open", { pageId: page.id, source: page.importMeta?.source });
      return page;
    }
    case "FORGET_BROWSED":
      return forgetBrowsed();
    case "GET_PAGE":
      return payload.id ? getPage(payload.id) : getPageByUrl(payload.url);
    case "LIST_PAGES":
      return listPages();
    case "SEARCH_PAGES":
      return searchPages(payload.query);
    case "SEARCH_HIGHLIGHTS":
      return searchHighlights(payload.query, payload.limit);
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
    case "TOGGLE_READING_LIST":
      return toggleReadingList(payload);
    case "QUEUE_READING_LIST":
      return queueReadingList(payload);
    case "ENSURE_PAGE":
      return ensurePage(payload);
    case "SET_TAGS":
      return setTags(payload.id, payload.tags);
    case "ADD_HIGHLIGHT":
      return addHighlight(payload);
    case "REMOVE_HIGHLIGHT":
      return removeHighlight(payload.pageId, payload.highlightId);
    case "PATCH_HIGHLIGHT":
      return patchHighlight(payload);
    case "REPORT_ANCHORS":
      return reportAnchors(payload);
    case "ADD_MESSAGE":
      return addMessage(payload);
    case "DELETE_MESSAGE":
      return deleteMessage(payload);
    case "FORK_THREAD":
      return forkThread(payload);
    case "SET_THREAD_STATUS":
      return setThreadStatus(payload);
    case "BUILD_AGENT_PACKET":
      return makePacket(payload);
    case "ASK_AGENT":
      return askAgentLive(payload);
    case "MARKUP_PAGE":
      return markupPage(payload);
    case "GET_MARKUP":
      return readMarkup(payload);
    case "CLEAR_MARKUP":
      return { cleared: await deleteMarkup(glossaryPageId(payload)) };
    case "KEEP_MARK":
      return keepMark(payload);
    case "EXPLAIN_SYMBOL":
      return explainSymbol(payload);
    case "GET_GLOSSARY":
      return readGlossary(payload);
    case "PING_AGENT_HOST":
      return pingAgentHostStatus();
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
    case "ADD_RSS_FEED":
      return addRssFeed(payload);
    case "ADD_RSS_FEEDS":
      return addRssFeeds(payload);
    case "UPDATE_RSS_FEED":
      return updateRssFeed(payload);
    case "REMOVE_RSS_FEED":
      return removeRssFeed(payload.id);
    case "SYNC_RSS":
      return runRssSync(payload.feedId);
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

/**
 * Clears records left behind by older builds, which stored every page you
 * opened. Only pages with no sign of intent go; anything kept stays.
 */
async function forgetBrowsed() {
  const pages = await listPages();
  const stale = pages.filter((page) => !isKept(page));
  for (const page of stale) await deletePage(page.id);
  return { removed: stale.length, kept: pages.length - stale.length };
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

async function toggleReadingList(payload) {
  const page = payload.id
    ? await getPage(payload.id)
    : await getPageByUrl(payload.url);
  if (!page) {
    if (!payload.url) throw new Error("Page not found");
    return queueReadingList(payload);
  }
  const next = payload.on ?? !page.inReadingList;
  page.inReadingList = Boolean(next);
  return putPage(page);
}

async function ensurePage(payload) {
  const url = payload.url || "";
  if (!url) throw new Error("URL required");
  const existing = await getPageByUrl(url);
  const tags = mergeTags(
    existing?.tags,
    Array.isArray(payload.tags) ? payload.tags : parseTagInput(payload.tags)
  );
  if (existing) {
    if (payload.title && (!existing.title || existing.title === existing.canonicalUrl)) {
      existing.title = payload.title;
    }
    if (tags.length) existing.tags = tags;
    return putPage(existing);
  }
  const page = await upsertPageFromVisit(url, {
    title: payload.title,
    tags,
    inReadingList: false,
    visited: payload.visited
  });
  page.inReadingList = false;
  page.tags = tags;
  return putPage(page);
}

async function queueReadingList(payload) {
  const url = payload.url || "";
  if (!url) throw new Error("URL required");
  const existing = await getPageByUrl(url);
  const tags = mergeTags(
    existing?.tags,
    Array.isArray(payload.tags) ? payload.tags : parseTagInput(payload.tags)
  );
  if (existing) {
    existing.inReadingList = true;
    if (payload.title && (!existing.title || existing.title === existing.canonicalUrl)) {
      existing.title = payload.title;
    }
    existing.tags = tags;
    return putPage(existing);
  }
  const page = await upsertPageFromVisit(url, {
    title: payload.title,
    tags,
    inReadingList: true,
    visited: payload.visited
  });
  page.inReadingList = true;
  page.tags = tags;
  return putPage(page);
}

async function setTags(id, tags) {
  const page = await getPage(id);
  if (!page) throw new Error("Page not found");
  page.tags = mergeTags(Array.isArray(tags) ? tags : parseTagInput(tags));
  return putPage(page);
}

async function addRssFeeds(payload) {
  const rows = Array.isArray(payload.urls)
    ? payload.urls.map((url) => ({ url, tags: [] }))
    : parseRssUrlInput(payload.text || "");
  if (!rows.length) throw new Error("No feed URLs found");
  const shared = mergeTags(
    Array.isArray(payload.tags) ? payload.tags : parseTagInput(payload.tags)
  );
  const settings = await getSettings();
  let rssFeeds = [...(settings.rssFeeds || [])];
  const added = [];
  for (const row of rows) {
    const url = canonicalizeUrl(row.url || "");
    if (!url) continue;
    const tags = mergeTags(row.tags, shared);
    const existing = rssFeeds.find((feed) => feed.url === url);
    const feed = existing
      ? {
          ...existing,
          tags: mergeTags(existing.tags, tags),
          enabled: true
        }
      : {
          id: uid("rss"),
          url,
          title: url,
          tags,
          enabled: true,
          addedAt: Date.now()
        };
    rssFeeds = existing
      ? rssFeeds.map((item) => (item.id === feed.id ? feed : item))
      : [...rssFeeds, feed];
    added.push(feed);
  }
  const next = await saveSettings({ rssFeeds });
  const synced = await syncRssFeeds({
    settings: next,
    importItems: upsertImportedPages
  });
  return { feeds: added, settings: next, ...synced };
}

async function addRssFeed(payload) {
  const settings = await getSettings();
  const url = canonicalizeUrl(payload.url || "");
  if (!url) throw new Error("Feed URL required");
  const tags = mergeTags(Array.isArray(payload.tags) ? payload.tags : parseTagInput(payload.tags));
  const current = settings.rssFeeds || [];
  const existing = current.find((feed) => feed.url === url);
  const feed = existing
    ? {
        ...existing,
        title: payload.title || existing.title,
        tags: mergeTags(existing.tags, tags),
        enabled: true
      }
    : {
        id: uid("rss"),
        url,
        title: payload.title || url,
        tags,
        enabled: true,
        addedAt: Date.now()
      };
  const rssFeeds = existing
    ? current.map((row) => (row.id === feed.id ? feed : row))
    : [...current, feed];
  const next = await saveSettings({ rssFeeds });
  const synced = await syncRssFeeds({
    settings: next,
    importItems: upsertImportedPages,
    feedId: feed.id
  });
  return { feed, settings: next, ...synced };
}

async function updateRssFeed(payload) {
  const settings = await getSettings();
  const rssFeeds = (settings.rssFeeds || []).map((feed) => {
    if (feed.id !== payload.id) return feed;
    return {
      ...feed,
      title: payload.title ?? feed.title,
      tags: payload.tags ? mergeTags(payload.tags) : feed.tags,
      enabled: payload.enabled ?? feed.enabled
    };
  });
  return saveSettings({ rssFeeds });
}

async function removeRssFeed(id) {
  const settings = await getSettings();
  const rssFeeds = (settings.rssFeeds || []).filter((feed) => feed.id !== id);
  return saveSettings({ rssFeeds });
}

async function runRssSync(feedId) {
  const settings = await getSettings();
  const { flags } = resolveFlags(settings);
  if (!flags.rss) return { ok: false, reason: "disabled", imported: 0 };
  return syncRssFeeds({
    settings,
    importItems: upsertImportedPages,
    feedId
  });
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
  return { page };
}

async function patchHighlight(payload) {
  const page = await loadPage(payload);
  const highlight = (page.highlights || []).find((h) => h.id === payload.highlightId);
  if (!highlight) throw new Error("Highlight not found");
  const patch = payload.patch || payload;
  if (patch.color) {
    if (!COLOR_IDS.includes(patch.color)) throw new Error("Unknown highlight color");
    highlight.color = patch.color;
  }
  if (typeof patch.text === "string") {
    const text = patch.text.trim();
    if (!text) throw new Error("Empty highlight");
    highlight.text = text;
    if (typeof patch.prefix === "string") highlight.prefix = patch.prefix;
    if (typeof patch.suffix === "string") highlight.suffix = patch.suffix;
    // Re-pointing a highlight at a span someone just selected settles the
    // question of where it belongs; whatever doubt the old quote carried is
    // no longer about this highlight.
    highlight.anchor = {
      state: "found",
      rung: 1,
      at: Date.now(),
      missStreak: 0,
      url: page.canonicalUrl || page.url || ""
    };
  }
  await putPage(page);
  return { page, highlight };
}

/**
 * Records what the live page did with each highlight's quote.
 *
 * Called once per page load, not once per attempt. Writes nothing when every
 * verdict matches what the record already believed, which is the ordinary
 * case — anchoring is not an edit, and it must not look like one.
 */
async function reportAnchors(payload) {
  const page = await loadPage(payload);
  const verdicts = payload.verdicts || [];
  if (!verdicts.length) return { page, changed: 0 };
  const byId = new Map((page.highlights || []).map((h) => [h.id, h]));
  const now = Date.now();
  let changed = 0;
  for (const verdict of verdicts) {
    const highlight = byId.get(verdict.highlightId);
    if (!highlight) continue;
    const merged = mergeAnchorVerdict(
      highlight.anchor,
      { ...verdict, url: payload.url || page.canonicalUrl || "" },
      now
    );
    if (!merged.changed) continue;
    highlight.anchor = merged.anchor;
    changed += 1;
  }
  if (!changed) return { page, changed: 0 };
  const saved = await putPage(page, { touch: false });
  return { page: saved, changed };
}

async function addMessage(payload) {
  const page = await loadPage(payload);
  const thread = page.threads.find((t) => t.id === payload.threadId);
  if (!thread) throw new Error("Thread not found");
  const message = newMessage(payload.message || payload);
  if (!message.content) throw new Error("Empty message");
  thread.messages.push(message);
  if (message.role === "agent") thread.awaitingAgent = null;
  if (payload.status) thread.status = payload.status;
  if (payload.agentSession) thread.agentSession = payload.agentSession;
  await putPage(page);
  return { page, thread, message };
}

async function deleteMessage(payload) {
  const page = await loadPage(payload);
  const thread = page.threads.find((t) => t.id === payload.threadId);
  if (!thread) throw new Error("Thread not found");
  const before = thread.messages.length;
  thread.messages = (thread.messages || []).filter((m) => m.id !== payload.messageId);
  if (thread.messages.length === before) throw new Error("Message not found");
  await putPage(page);
  return { page, thread };
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

function sameAgentSession(thread, agent) {
  const session = thread?.agentSession;
  if (!session?.id) return "";
  if (session.agent && session.agent !== agent) return "";
  return session.id;
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
    agent: payload.agent,
    model: payload.model
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
    thread.awaitingAgent = {
      agent: payload.agent || "cursor",
      model: payload.model || "",
      packet: packet.markdown,
      askedAt: Date.now(),
      status: "pending"
    };
    await putPage(page);
  }
  return { packet, page, thread };
}

async function pingAgentHostStatus() {
  const settings = await ensureAgentHostPaired();
  let probe = await pingAgentHost(settings);
  if (probe.status === 401 || probe.auth === false) {
    const paired = await pairAgentHost(settings);
    if (paired.token && paired.token !== settings.agentHostToken) {
      const next = await saveSettings({ agentHostToken: paired.token });
      probe = await pingAgentHost(next);
      return {
        ...probe,
        url: next.agentHostUrl || "http://127.0.0.1:17321",
        paired: Boolean(next.agentHostToken)
      };
    }
  }
  return {
    ...probe,
    url: settings.agentHostUrl || "http://127.0.0.1:17321",
    paired: Boolean(settings.agentHostToken)
  };
}

async function ensureAgentHostPaired() {
  const settings = await getSettings();
  if (settings.agentHostToken) return settings;
  const paired = await pairAgentHost(settings);
  if (!paired.token) return settings;
  return saveSettings({ agentHostToken: paired.token });
}

async function askAgentLive(payload) {
  const settings = await ensureAgentHostPaired();
  const agent = payload.agent || settings.agentDefault || "cursor";
  const model =
    payload.model ||
    (agent === "claude-code" ? settings.claudeCodeModel : settings.cursorModel) ||
    "";
  const built = await makePacket({
    ...payload,
    agent,
    model,
    commit: true,
    recordAsk: true
  });
  try {
    const result = await runAgentAsk({
      settings,
      agent,
      model,
      packet: built.packet.markdown,
      resumeId: sameAgentSession(built.thread, agent)
    });
    const text = cleanAgentReply(typeof result === "string" ? result : result.text);
    const sessionId = typeof result === "string" ? "" : result.sessionId || "";
    const workspace = typeof result === "string" ? "" : result.workspace || "";
    return addMessage({
      pageId: built.page.id,
      threadId: built.thread.id,
      message: { role: "agent", agent, content: text },
      agentSession: sessionId
        ? { agent, id: sessionId, workspace: workspace || built.thread.agentSession?.workspace || "" }
        : built.thread.agentSession
    });
  } catch (error) {
    const page = await getPage(built.page.id);
    const thread = page.threads.find((t) => t.id === built.thread.id);
    if (thread?.awaitingAgent) {
      thread.awaitingAgent.status = "error";
      thread.awaitingAgent.error = error.message || String(error);
      await putPage(page);
    }
    throw error;
  }
}

/**
 * An explanation costs a full agent turn, so it is written down against the
 * page it was asked on and never bought twice.
 */
/**
 * Reads an article ahead of you and marks the few passages worth stopping at.
 *
 * Cached against the page and its content hash, so it runs once per version of
 * an article however often you come back. Nothing here creates a page record:
 * a machine reading a page on your behalf is still not you keeping it.
 */
async function markupPage(payload) {
  const pageId = glossaryPageId(payload);
  const parsed = payload.parsed || {};
  const contentHash = parsed.contentHash || "";

  const cached = await getMarkup(pageId, contentHash);
  if (cached) return { ...cached, cached: true };
  // Loading a page may repaint an earlier pass but must never buy a new one.
  // An agent call is something you ask for.
  if (payload.cachedOnly) return { pageId, contentHash, marks: [], skipped: "not-asked" };
  if (!articleIsWorthMarking(parsed)) return { pageId, contentHash, marks: [], skipped: "short" };

  const settings = await ensureAgentHostPaired();
  const agent = settings.agentDefault || "cursor";
  const model = (agent === "claude-code" ? settings.claudeCodeModel : settings.cursorModel) || "";
  const packet = buildMarkupPacket({
    pageTitle: String(payload.pageTitle || "").slice(0, 300),
    url: String(payload.url || "").slice(0, 2000),
    blocks: parsed.blocks || [],
    wordCount: parsed.wordCount || 0
  });

  const result = await runAgentAsk({ settings, agent, model, packet });
  const reply = cleanAgentReply(typeof result === "string" ? result : result.text);
  // Anchoring is the trust boundary: a quote the article does not contain is
  // dropped here rather than painted somewhere approximate.
  const marks = anchorMarkup(
    parseMarkupReply(reply, markCeiling(parsed.wordCount || 0)),
    parsed.blocks || []
  ).map((mark) => ({
    ...mark,
    id: uid("am")
  }));

  return {
    ...(await putMarkup({ pageId, contentHash, url: payload.url || "", agent, marks })),
    cached: false
  };
}

async function readMarkup(payload) {
  const pageId = glossaryPageId(payload);
  const row = await getMarkup(pageId, payload.contentHash || "");
  return row || { pageId, contentHash: payload.contentHash || "", marks: [] };
}

/**
 * Turns one of the machine's marks into your own highlight.
 *
 * This is the moment the page becomes kept — engaging with a suggestion is an
 * act of keeping, where merely having it suggested to you was not. The mark
 * leaves the markup set so the same passage is not shown twice.
 */
async function keepMark(payload) {
  const mark = payload.mark || {};
  if (!mark.text) throw new Error("Nothing to keep");
  if (!payload.url) throw new Error("URL required");
  // The record may not exist: nothing was written while the page was merely
  // read, or merely marked up. Keeping one of the marks is what creates it.
  const owner = await ensurePage({ url: payload.url, title: payload.pageTitle, visited: true });
  const result = await addHighlight({
    pageId: owner.id,
    highlight: {
      color: mark.color || "lemon",
      text: mark.text,
      prefix: mark.prefix || "",
      suffix: mark.suffix || ""
    },
    comment: mark.why ? `Marked by ${payload.agent || "an agent"}: ${mark.why}` : ""
  });

  const pageId = result.page.id;
  const row = await getMarkup(pageId, payload.contentHash || "");
  if (row) {
    await putMarkup({
      ...row,
      marks: (row.marks || []).filter((item) => item.id !== mark.id)
    });
  }
  return result;
}

async function explainSymbol(payload) {
  const term = String(payload.term || "").trim();
  const termKey = String(payload.termKey || term).trim().toLocaleLowerCase();
  if (!term || !termKey) throw new Error("Term required");
  const pageId = glossaryPageId(payload);
  const cached = await getGloss(pageId, termKey);
  if (cached?.text) return { text: cached.text, cached: true };

  const settings = await ensureAgentHostPaired();
  const agent = settings.agentDefault || "cursor";
  const model =
    (agent === "claude-code" ? settings.claudeCodeModel : settings.cursorModel) ||
    "";
  const packet = buildSymbolExplainPacket({
    term: term.slice(0, 80),
    pageTitle: String(payload.pageTitle || "").slice(0, 300),
    url: String(payload.url || "").slice(0, 2000),
    anchorText: String(payload.anchorText || "").slice(0, 800),
    nearbyBlocks: (payload.nearbyBlocks || []).slice(0, 5)
  });
  const result = await runAgentAsk({ settings, agent, model, packet });
  const text = glossText(cleanAgentReply(typeof result === "string" ? result : result.text));
  if (!text) throw new Error("The agent returned nothing to explain that term with.");
  await putGloss({
    pageId,
    termKey,
    term,
    text,
    kept: Boolean(await getPage(pageId))
  });
  return { text, cached: false, agent, model };
}

async function readGlossary(payload) {
  const rows = await listGlossary(glossaryPageId(payload));
  const entries = {};
  for (const row of rows) {
    if (row?.termKey && row.text) entries[row.termKey] = row.text;
  }
  return { entries };
}

function glossaryPageId(payload) {
  if (payload.pageId) return payload.pageId;
  const url = String(payload.url || "").trim();
  if (!url) throw new Error("pageId or url required");
  return pageIdFromUrl(canonicalizeUrl(url));
}

function cleanAgentReply(value) {
  const lines = String(value || "").split("\n");
  while (
    lines.length &&
    /^(reading|opening|checking|looking at|i(?:'m| am) (?:reading|checking|opening)).*(?:packet(?:\.md)?|file|page)/i.test(
      lines[0].trim().replace(/`/g, "")
    )
  ) {
    lines.shift();
  }
  return lines.join("\n").trim() || "I couldn’t form a useful reply from this passage.";
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
