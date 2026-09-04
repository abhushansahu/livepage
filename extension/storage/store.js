import { uid } from "../shared/id.js";
import { isWaiting } from "../shared/progress.js";
import { canonicalizeUrl, hostnameOf, pageIdFromUrl } from "../shared/url.js";
import { contentTags, mergeTags } from "../shared/tags.js";
import { highlightMatches, pageMatchesQuery } from "../shared/search.js";
import { DEFAULT_EXPERIMENT } from "../shared/flags.js";

const DB_NAME = "livepage";
const DB_VERSION = 6;

export const DEFAULT_SETTINGS = {
  defaultColor: "lemon",
  pageTheme: "coffee",
  highlightStrength: 48,
  obsidianVault: "",
  obsidianFolder: "livepage",
  reminderHour: 9,
  reminderMinute: 0,
  remindersEnabled: true,
  agentDefault: "cursor",
  cursorModel: "composer-2.5",
  claudeCodeModel: "sonnet",
  cursorAgentPath: "",
  claudeCodePath: "",
  agentHostUrl: "http://127.0.0.1:17321",
  agentHostToken: "",
  agentWorkspace: "",
  allowInfiniteSnapshot: true,
  lockInfiniteScroll: true,
  importSavesEnabled: true,
  localTweetsEnabled: false,
  rssFeeds: [],
  flags: {},
  experiment: { ...DEFAULT_EXPERIMENT },
  vault: { bound: false, name: "", boundAt: 0 }
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pages")) {
        const pages = db.createObjectStore("pages", { keyPath: "id" });
        pages.createIndex("canonicalUrl", "canonicalUrl", { unique: false });
        pages.createIndex("updatedAt", "updatedAt");
        pages.createIndex("readState", "readState");
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("ledger")) {
        db.createObjectStore("ledger", { keyPath: "pageId" });
      }
      if (!db.objectStoreNames.contains("events")) {
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("at", "at");
        events.createIndex("kind", "kind");
      }
      if (!db.objectStoreNames.contains("mind")) {
        db.createObjectStore("mind", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("vaultMeta")) {
        db.createObjectStore("vaultMeta", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("glossary")) {
        const glossary = db.createObjectStore("glossary", { keyPath: "key" });
        glossary.createIndex("pageId", "pageId");
        glossary.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("LivePage database blocked"));
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = fn(store);
  await txDone(tx);
  return result;
}

function reqOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function emptyPage(url, extras = {}) {
  const canonicalUrl = canonicalizeUrl(url);
  const ts = Date.now();
  return {
    id: pageIdFromUrl(canonicalUrl),
    url,
    canonicalUrl,
    title: extras.title || canonicalUrl,
    domain: hostnameOf(canonicalUrl),
    createdAt: ts,
    updatedAt: ts,
    lastVisitedAt: ts,
    openedAt: extras.openedAt || null,
    readState: "unread",
    bookmarked: false,
    inReadingList: Boolean(extras.inReadingList),
    why: extras.why || "",
    importMeta: extras.importMeta || null,
    snoozedUntil: 0,
    tags: mergeTags(extras.tags),
    infiniteScroll: false,
    snapshot: null,
    parsed: {
      excerpt: "",
      headings: [],
      wordCount: 0,
      contentHash: "",
      blocks: []
    },
    highlights: [],
    threads: [],
    progress: {
      percent: 0,
      maxPercent: 0,
      scrollY: 0,
      updatedAt: ts
    }
  };
}

export async function getSettings() {
  const row = await withStore("settings", "readonly", (store) =>
    reqOf(store.get("app"))
  );
  return { ...DEFAULT_SETTINGS, ...(row?.value || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await withStore("settings", "readwrite", (store) => {
    store.put({ key: "app", value: next });
  });
  return next;
}

export async function getPage(id) {
  return withStore("pages", "readonly", (store) => reqOf(store.get(id)));
}

export async function getPageByUrl(url) {
  const id = pageIdFromUrl(canonicalizeUrl(url));
  return getPage(id);
}

/**
 * Writes a page back.
 *
 * `touch: false` keeps the existing updatedAt. Bookkeeping the reader never
 * asked for — re-checking whether a highlight still anchors, merging a backup
 * — must not claim the page was touched, or "recently updated" stops meaning
 * anything and a later merge reads this machine as newer than it is.
 */
export async function putPage(page, { touch = true } = {}) {
  const next = touch ? { ...page, updatedAt: Date.now() } : { ...page };
  await withStore("pages", "readwrite", (store) => {
    store.put(next);
  });
  return next;
}

/**
 * Updates the record for a page, and creates one only when asked to. Merely
 * loading a page passes `createIfMissing: false` so ordinary browsing leaves
 * nothing behind; the record appears the first time you keep the page.
 */
export async function upsertPageFromVisit(url, meta = {}) {
  const existing = await getPageByUrl(url);
  // Queueing a link is not opening it. Only a real visit may claim otherwise,
  // or "never opened" stops meaning anything.
  const visited = meta.visited !== false;
  if (existing) {
    if (visited) {
      existing.lastVisitedAt = Date.now();
      existing.openedAt = Date.now();
    }
    if (meta.title && (!existing.title || existing.title === existing.canonicalUrl)) {
      existing.title = meta.title;
    }
    if (meta.parsed) existing.parsed = mergeParsed(existing.parsed, meta.parsed);
    if (typeof meta.infiniteScroll === "boolean") {
      existing.infiniteScroll = meta.infiniteScroll;
    }
    return putPage(existing);
  }
  if (meta.createIfMissing === false) return null;
  const page = emptyPage(url, meta);
  page.openedAt = visited ? Date.now() : null;
  if (!visited) page.lastVisitedAt = 0;
  if (meta.parsed) page.parsed = meta.parsed;
  if (typeof meta.infiniteScroll === "boolean") page.infiniteScroll = meta.infiniteScroll;
  return putPage(page);
}

function mergeParsed(oldParsed = {}, incoming = {}) {
  const byId = new Map();
  for (const block of oldParsed.blocks || []) byId.set(block.id, block);
  for (const block of incoming.blocks || []) {
    if (!byId.has(block.id)) byId.set(block.id, block);
  }
  return {
    excerpt: incoming.excerpt || oldParsed.excerpt || "",
    headings: incoming.headings?.length ? incoming.headings : oldParsed.headings || [],
    wordCount: incoming.wordCount || oldParsed.wordCount || 0,
    contentHash: incoming.contentHash || oldParsed.contentHash || "",
    blocks: [...byId.values()]
  };
}

export async function listPages() {
  const db = await openDb();
  const tx = db.transaction("pages", "readonly");
  const pages = await reqOf(tx.objectStore("pages").getAll());
  pages.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return pages;
}

export async function deletePage(id) {
  await withStore("pages", "readwrite", (store) => store.delete(id));
  await withStore("ledger", "readwrite", (store) => store.delete(id));
  await deleteGlossary(id);
}

export function glossKey(pageId, termKey) {
  return `${pageId}::${termKey}`;
}

export async function getGloss(pageId, termKey) {
  try {
    return await withStore("glossary", "readonly", (store) =>
      reqOf(store.get(glossKey(pageId, termKey)))
    );
  } catch {
    return null;
  }
}

export async function listGlossary(pageId) {
  try {
    const db = await openDb();
    const tx = db.transaction("glossary", "readonly");
    return await reqOf(tx.objectStore("glossary").index("pageId").getAll(pageId));
  } catch {
    return [];
  }
}

export async function putGloss(entry) {
  const row = {
    key: glossKey(entry.pageId, entry.termKey),
    pageId: entry.pageId,
    termKey: entry.termKey,
    term: entry.term || "",
    text: entry.text || "",
    kept: Boolean(entry.kept),
    createdAt: Date.now()
  };
  await withStore("glossary", "readwrite", (store) => store.put(row));
  await pruneGlossary();
  return row;
}

async function deleteGlossary(pageId) {
  try {
    const rows = await listGlossary(pageId);
    if (!rows.length) return;
    await withStore("glossary", "readwrite", (store) => {
      for (const row of rows) store.delete(row.key);
    });
  } catch {
    /* nothing cached for this page */
  }
}

/**
 * Explanations for pages you kept are the ones worth paying an agent for
 * twice, so passing traffic is evicted first when the cache outgrows its bound.
 */
async function pruneGlossary(keep = 3000) {
  const db = await openDb();
  const tx = db.transaction("glossary", "readwrite");
  const store = tx.objectStore("glossary");
  const rows = await reqOf(store.getAll());
  if (rows.length <= keep) {
    await txDone(tx);
    return;
  }
  rows.sort(
    (a, b) => Number(a.kept) - Number(b.kept) || (a.createdAt || 0) - (b.createdAt || 0)
  );
  for (const row of rows.slice(0, rows.length - keep)) store.delete(row.key);
  await txDone(tx);
}

export async function getLedger(pageId) {
  const row = await withStore("ledger", "readonly", (store) =>
    reqOf(store.get(pageId))
  );
  return (
    row || {
      pageId,
      sentBlockIds: [],
      sentHighlightIds: [],
      sentThreadIds: [],
      lastSentAt: 0
    }
  );
}

export async function saveLedger(ledger) {
  await withStore("ledger", "readwrite", (store) => store.put(ledger));
  return ledger;
}

export async function searchPages(query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  const pages = await listPages();
  if (!q) return pages;
  return pages.filter((page) => pageMatches(page, q));
}

export function pageMatches(page, q) {
  return pageMatchesQuery(page, q);
}

/**
 * The passages themselves, rather than the pages holding them. Lean rows: a
 * query can match hundreds of highlights, and the whole page record behind
 * each one has no business crossing a message boundary.
 */
export async function searchHighlights(query, limit = 60) {
  const pages = await listPages();
  return highlightMatches(pages, query, { limit }).map((item) => ({
    page: {
      id: item.page.id,
      title: item.page.title,
      domain: item.page.domain,
      url: item.page.url,
      tags: item.page.tags || [],
      updatedAt: item.page.updatedAt || 0
    },
    highlightId: item.highlight.id,
    threadId: item.thread?.id || null,
    text: item.highlight.text,
    color: item.highlight.color || "",
    field: item.field,
    snippet: item.snippet,
    messageCount: item.thread?.messages?.length || 0,
    lastRole: item.last?.role || null,
    awaiting: item.awaiting,
    parentId: item.thread?.parentId || null,
    branchLabel: item.thread?.branchLabel || "",
    createdAt: item.highlight.createdAt || 0
  }));
}

export async function unreadPages() {
  const pages = await listPages();
  return pages.filter(isWaiting);
}

export async function upsertImportedPages(items) {
  let imported = 0;
  let updated = 0;
  for (const item of items || []) {
    if (!item?.url) continue;
    const existing = await getPageByUrl(item.url);
    if (existing) {
      existing.importMeta = {
        ...(existing.importMeta || {}),
        ...item.importMeta,
        importedAt: existing.importMeta?.importedAt || item.importMeta?.importedAt || Date.now(),
        lastSyncedAt: Date.now()
      };
      existing.tags = mergeTags(existing.tags, item.tags);
      if (item.bookmarked) existing.bookmarked = true;
      if (item.title && (!existing.title || existing.title === existing.canonicalUrl)) {
        existing.title = item.title;
      }
      if (item.excerpt && !existing.parsed?.excerpt) {
        existing.parsed = { ...(existing.parsed || {}), excerpt: item.excerpt };
      }
      if (item.why && !existing.why) existing.why = item.why;
      await putPage(existing);
      updated += 1;
      continue;
    }
    const page = emptyPage(item.url, {
      title: item.title,
      why: item.why,
      importMeta: item.importMeta,
      tags: item.tags
    });
    page.bookmarked = Boolean(item.bookmarked);
    page.lastVisitedAt = 0;
    page.openedAt = null;
    page.parsed = { ...page.parsed, excerpt: item.excerpt || "" };
    await putPage(page);
    imported += 1;
  }
  return { imported, updated, total: imported + updated };
}

/**
 * A highlight is a text quote, not a position, so it can outlive the markup it
 * was made on. Highlights may also carry an optional `anchor` summarising how
 * the last live page treated that quote — see shared/anchors.js. It is absent
 * until a page is actually visited, and deliberately not part of the record a
 * highlight is born with.
 */
export function newHighlight(partial) {
  return {
    id: uid("hl"),
    color: partial.color || "lemon",
    text: partial.text || "",
    prefix: partial.prefix || "",
    suffix: partial.suffix || "",
    createdAt: Date.now(),
    threadId: partial.threadId || null
  };
}

export function newThread(partial) {
  return {
    id: uid("th"),
    highlightId: partial.highlightId,
    parentId: partial.parentId || null,
    forkedFromMessageId: partial.forkedFromMessageId || null,
    branchLabel: partial.branchLabel || "main",
    status: partial.status || "open",
    createdAt: Date.now(),
    messages: partial.messages || []
  };
}

export function newMessage(partial) {
  return {
    id: uid("msg"),
    role: partial.role || "user",
    agent: partial.agent || null,
    content: String(partial.content || "").trim(),
    createdAt: Date.now()
  };
}

export const EMPTY_MIND = { key: "app", signals: {}, lastAct: null };

export async function getMind() {
  try {
    const row = await withStore("mind", "readonly", (store) => reqOf(store.get("app")));
    return { ...EMPTY_MIND, ...(row || {}) };
  } catch {
    return { ...EMPTY_MIND };
  }
}

export async function saveMind(mind) {
  const next = { ...EMPTY_MIND, ...mind, key: "app" };
  await withStore("mind", "readwrite", (store) => {
    store.put(next);
  });
  return next;
}

export async function recordEvent(partial = {}) {
  const event = {
    id: uid("ev"),
    at: partial.at || Date.now(),
    kind: partial.kind || "note",
    pageId: partial.pageId || null,
    signal: partial.signal || null,
    source: partial.source || null,
    meta: partial.meta || {}
  };
  await withStore("events", "readwrite", (store) => {
    store.put(event);
  });
  await trimEvents();
  return event;
}

export async function listEvents(limit = 250) {
  try {
    const db = await openDb();
    const tx = db.transaction("events", "readonly");
    const rows = await reqOf(tx.objectStore("events").getAll());
    rows.sort((a, b) => (b.at || 0) - (a.at || 0));
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

async function trimEvents(keep = 400) {
  const db = await openDb();
  const tx = db.transaction("events", "readwrite");
  const store = tx.objectStore("events");
  const rows = await reqOf(store.getAll());
  if (rows.length <= keep) {
    await txDone(tx);
    return;
  }
  rows.sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const row of rows.slice(0, rows.length - keep)) store.delete(row.id);
  await txDone(tx);
}

export async function getVaultMeta() {
  try {
    return await withStore("vaultMeta", "readonly", (store) => reqOf(store.get("dir")));
  } catch {
    return null;
  }
}

export async function saveVaultMeta(meta) {
  const next = { id: "dir", ...meta };
  await withStore("vaultMeta", "readwrite", (store) => {
    store.put(next);
  });
  return next;
}
