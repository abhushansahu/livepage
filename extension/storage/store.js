import { uid } from "../shared/id.js";
import { canonicalizeUrl, hostnameOf, pageIdFromUrl } from "../shared/url.js";

const DB_NAME = "livepage";
const DB_VERSION = 1;

export const DEFAULT_SETTINGS = {
  defaultColor: "lemon",
  obsidianVault: "",
  obsidianFolder: "LivePage",
  reminderHour: 9,
  reminderMinute: 0,
  remindersEnabled: true,
  agentDefault: "cursor",
  allowInfiniteSnapshot: true,
  lockInfiniteScroll: true
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
    };
    req.onsuccess = () => resolve(req.result);
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
    readState: "unread",
    bookmarked: false,
    why: extras.why || "",
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
    threads: []
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
  return pages.filter((p) => p.readState === "unread" || p.readState === "in_progress");
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
