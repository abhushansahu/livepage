/** Normalize, merge, and derive tags so every surface can filter the same way. */

export function normalizeTag(value) {
  const slug = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[#]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || slug.length > 48) return "";
  return slug;
}

export function parseTagInput(value) {
  return mergeTags(
    String(value || "")
      .split(/[,;\n]+/)
      .flatMap((part) => part.trim().replace(/^#/, "").split(/\s+/))
  );
}

export function mergeTags(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of list || []) {
      const tag = normalizeTag(raw);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export function derivedTags(page = {}) {
  const tags = [];
  const source = page.importMeta?.source;
  const kind = page.importMeta?.kind;
  if (source) tags.push(source);
  if (kind && normalizeTag(kind) !== source) tags.push(kind);
  if (page.bookmarked) tags.push("bookmark");
  if (page.readState === "parked") tags.push("parked");
  if (page.readState === "released") tags.push("released");
  const messages = (page.threads || []).flatMap((thread) => thread.messages || []);
  if (messages.some((m) => m.role === "user")) tags.push("user-comment");
  if (messages.some((m) => m.role === "agent")) tags.push("ai-comment");
  for (const message of messages) {
    if (message.role === "agent" && message.agent) tags.push(message.agent);
  }
  return mergeTags(tags);
}

export function contentTags(page = {}) {
  return mergeTags(page.tags, derivedTags(page));
}

export function pageHasTags(page, required = []) {
  const need = mergeTags(required);
  if (!need.length) return true;
  const have = new Set(contentTags(page));
  return need.every((tag) => have.has(tag));
}

export function allTagsFromPages(pages = []) {
  const counts = new Map();
  for (const page of pages) {
    for (const tag of contentTags(page)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

export function sortPages(pages, mode = "recent", now = Date.now()) {
  const copy = [...(pages || [])];
  const created = (page) => page.importMeta?.importedAt || page.createdAt || 0;
  if (mode === "oldest-unread") {
    return copy.sort((a, b) => {
      const aWait = waitingAge(a, now);
      const bWait = waitingAge(b, now);
      if (aWait !== bWait) return bWait - aWait;
      return created(a) - created(b);
    });
  }
  if (mode === "never-opened") {
    return copy.sort((a, b) => {
      const aOpen = a.openedAt ? 1 : 0;
      const bOpen = b.openedAt ? 1 : 0;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return created(a) - created(b);
    });
  }
  if (mode === "bookmarked") {
    return copy.sort((a, b) => {
      if (Boolean(a.bookmarked) !== Boolean(b.bookmarked)) {
        return a.bookmarked ? -1 : 1;
      }
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }
  if (mode === "title") {
    return copy.sort((a, b) =>
      String(a.title || a.url || "").localeCompare(String(b.title || b.url || ""))
    );
  }
  return copy.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function waitingAge(page, now) {
  const unread = (page.progress?.maxPercent || 0) < 90 && page.readState !== "released";
  if (!unread) return -1;
  return now - (page.importMeta?.importedAt || page.createdAt || now);
}
