import { uid } from "../shared/id.js";
import { isWaiting } from "../shared/progress.js";
import { canonicalizeUrl, hostnameOf, pageIdFromUrl } from "../shared/url.js";

const DB_NAME = "livepage";
const DB_VERSION = 3;

export const DEFAULT_SETTINGS = {
  defaultColor: "lemon",
  obsidianVault: "",
  obsidianFolder: "LivePage",
  reminderHour: 9,
  reminderMinute: 0,
  remindersEnabled: true,
  agentDefault: "cursor",
  allowInfiniteSnapshot: true,
  lockInfiniteScroll: true,
  importSavesEnabled: true,
  localTweetsEnabled: true
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
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pages")) {
        db.close();
        const del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = () => {
          dbPromise = null;
          openDb().then(resolve, reject);
        };
        del.onerror = () => reject(del.error || new Error("LivePage database is empty"));
        return;
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
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
    why: extras.why || "",
    importMeta: extras.importMeta || null,
    snoozedUntil: 0,
    tags: [],
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

export async function putPage(page) {
  const next = { ...page, updatedAt: Date.now() };
  await withStore("pages", "readwrite", (store) => {
    store.put(next);
  });
  return next;
}

export async function upsertPageFromVisit(url, meta = {}) {
  const existing = await getPageByUrl(url);
  if (existing) {
    existing.lastVisitedAt = Date.now();
    existing.openedAt = Date.now();
    if (meta.title && (!existing.title || existing.title === existing.canonicalUrl)) {
      existing.title = meta.title;
    }
    if (meta.parsed) existing.parsed = mergeParsed(existing.parsed, meta.parsed);
    if (typeof meta.infiniteScroll === "boolean") {
      existing.infiniteScroll = meta.infiniteScroll;
    }
    return putPage(existing);
  }
  const page = emptyPage(url, meta);
  page.openedAt = Date.now();
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
  const hay = [
    page.title,
    page.domain,
    page.url,
    page.why,
    page.readState,
    page.importMeta?.source,
    page.importMeta?.author,
    page.parsed?.excerpt,
    ...(page.parsed?.headings || []),
    ...(page.tags || []),
    ...(page.highlights || []).map((h) => h.text),
    ...(page.threads || []).flatMap((t) =>
      (t.messages || []).map((m) => m.content)
    )
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
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
      existing.bookmarked = true;
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
      importMeta: item.importMeta
    });
    page.bookmarked = true;
    page.lastVisitedAt = 0;
    page.openedAt = null;
    page.parsed = { ...page.parsed, excerpt: item.excerpt || "" };
    await putPage(page);
    imported += 1;
  }
  return { imported, updated, total: imported + updated };
}

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
