export function measureScrollProgress(win = window, doc = document) {
  const root = doc.documentElement;
  const body = doc.body;
  const total = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0, 1);
  const seen = (win.scrollY || root?.scrollTop || 0) + (win.innerHeight || 0);
  return clampPercent(Math.round((seen / total) * 100));
}

export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function applyProgress(page, percent, scrollY = 0) {
  const next = clampPercent(percent);
  const maxPercent = Math.max(page.progress?.maxPercent || 0, next);
  page.progress = {
    percent: next,
    maxPercent,
    scrollY,
    updatedAt: Date.now()
  };
  if (page.readState !== "parked" && page.readState !== "released") {
    page.readState = deriveReadState(maxPercent);
  }
  return page;
}

export function deriveReadState(maxPercent) {
  const p = clampPercent(maxPercent);
  if (p >= 90) return "read";
  if (p > 8) return "in_progress";
  return "unread";
}

export function progressOf(page) {
  return page?.progress?.maxPercent ?? 0;
}

export function progressLabel(page) {
  if (page.readState === "parked") return "Parked";
  if (page.readState === "released") return "Released";
  const p = progressOf(page);
  if (p >= 90) return "Read through";
  if (p <= 8) return "Not started";
  return `${p}% through`;
}

export function isWaiting(page) {
  if (page.readState === "parked" || page.readState === "released") return false;
  return progressOf(page) < 90;
}

export function needsReview(page) {
  const threads = page.threads || [];
  return threads.some((thread) => {
    const last = thread.messages?.[thread.messages.length - 1];
    return last && last.role === "user";
  });
}

export function reviewItems(pages) {
  const items = [];
  for (const page of pages || []) {
    for (const thread of page.threads || []) {
      const last = thread.messages?.[thread.messages.length - 1];
      if (!last) continue;
      const highlight = (page.highlights || []).find((h) => h.id === thread.highlightId);
      items.push({
        page,
        thread,
        highlight,
        last,
        awaiting: last.role === "user"
      });
    }
  }
  items.sort((a, b) => (b.last.createdAt || 0) - (a.last.createdAt || 0));
  return items;
}
