import { contentTags } from "./tags.js";

/**
 * Finding a page is not the same as finding the sentence you wrote on.
 *
 * Page search answers "where was that article". Passage search answers "where
 * was that thought" — it returns the highlight, its thread, and the words that
 * matched, so the thing you were looking for is the result rather than the
 * haystack it lives in.
 */

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase();
}

/** The text of a page that a page-level query is matched against. */
function pageHaystack(page) {
  return [
    page.title,
    page.domain,
    page.url,
    page.why,
    page.readState,
    page.importMeta?.source,
    page.importMeta?.author,
    ...contentTags(page),
    page.parsed?.excerpt,
    ...(page.parsed?.headings || []),
    ...(page.tags || []),
    ...(page.highlights || []).map((h) => h.text),
    ...(page.threads || []).flatMap((t) => (t.messages || []).map((m) => m.content))
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export function pageMatchesQuery(page, query) {
  const q = normalizeQuery(query);
  if (!q) return true;
  return pageHaystack(page).includes(q);
}

/** How many passages from any one page may crowd out the rest. */
export const PER_PAGE_LIMIT = 5;
const SNIPPET_RADIUS = 90;

/**
 * Passages matching a query, best first.
 *
 * Iterates highlights rather than threads: every highlight is born with a
 * thread, but an uncommented one has no messages, and walking threads would
 * silently drop the plainest and most common kind of highlight there is.
 */
export function highlightMatches(pages, query, { limit = 120, perPage = PER_PAGE_LIMIT } = {}) {
  const q = normalizeQuery(query);
  if (!q) return [];

  const byPage = [];
  for (const page of pages || []) {
    const threads = page.threads || [];
    const found = [];
    for (const highlight of page.highlights || []) {
      const item = matchHighlight(page, highlight, threads, q);
      if (item) found.push(item);
    }
    if (!found.length) continue;
    found.sort(compareItems);
    byPage.push(found.slice(0, perPage));
  }

  // Interleave, so one heavily annotated article cannot fill the whole page of
  // results and hide every other page that matched.
  const merged = [];
  for (let rank = 0; ; rank += 1) {
    let took = false;
    for (const list of byPage) {
      if (rank < list.length) {
        merged.push(list[rank]);
        took = true;
      }
    }
    if (!took) break;
  }
  merged.sort(compareItems);
  return merged.slice(0, limit);
}

function matchHighlight(page, highlight, threads, q) {
  const mine = threads.filter((thread) => thread.highlightId === highlight.id);
  const thread = mine.find((t) => !t.parentId) || mine[0] || null;
  const messages = mine.flatMap((t) => t.messages || []);
  const last = messages.length
    ? messages.reduce((a, b) => ((b.createdAt || 0) >= (a.createdAt || 0) ? b : a))
    : null;
  const base = {
    page,
    highlight,
    thread,
    last,
    awaiting: last?.role === "user"
  };

  const text = highlight.text || "";
  if (text.toLowerCase().includes(q)) {
    return {
      ...base,
      field: "highlight",
      message: null,
      snippet: snippetAround(text, q),
      score: scoreHit("highlight", text, q, highlight)
    };
  }

  // Your own words before the agent's: you are looking for what you thought,
  // and only then for what it answered.
  const ordered = [...messages].sort(
    (a, b) => rankRole(a.role) - rankRole(b.role) || (a.createdAt || 0) - (b.createdAt || 0)
  );
  for (const message of ordered) {
    const body = message.content || "";
    if (!body.toLowerCase().includes(q)) continue;
    const field = message.role === "agent" ? "agent" : "user";
    return {
      ...base,
      field,
      message,
      snippet: snippetAround(body, q),
      score: scoreHit(field, body, q, highlight)
    };
  }
  return null;
}

function rankRole(role) {
  if (role === "user") return 0;
  if (role === "agent") return 1;
  return 2;
}

function scoreHit(field, text, query, highlight) {
  const base = { highlight: 300, user: 200, agent: 100 }[field] || 0;
  const body = String(text || "").toLowerCase();
  const q = normalizeQuery(query);
  const index = body.indexOf(q);
  // A whole word is what you meant; a fragment inside a longer word is a
  // coincidence more often than not.
  const before = index > 0 ? body[index - 1] : " ";
  const after = index + q.length < body.length ? body[index + q.length] : " ";
  const whole = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
  // A short quote containing the term is more use than a long one that happens
  // to mention it somewhere.
  const brevity = Math.max(0, 40 - Math.floor((highlight?.text || "").length / 40));
  return base + (whole ? 30 : 0) + brevity;
}

function compareItems(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const at = a.last?.createdAt || a.highlight?.createdAt || 0;
  const bt = b.last?.createdAt || b.highlight?.createdAt || 0;
  return bt - at;
}

/**
 * A window of text around the match, with the match's position in it.
 *
 * Returns offsets rather than markup so this stays pure and escaping stays
 * where the rendering is — the dashboard escapes everything by hand.
 */
export function snippetAround(text, query, { radius = SNIPPET_RADIUS } = {}) {
  const body = String(text || "");
  const q = normalizeQuery(query);
  const hit = body.toLowerCase().indexOf(q);
  if (hit < 0 || !q) {
    const clipped = body.slice(0, radius * 2);
    return { text: clipped + (body.length > clipped.length ? "…" : ""), start: 0, end: 0 };
  }

  let from = Math.max(0, hit - radius);
  let to = Math.min(body.length, hit + q.length + radius);
  // Do not cut a word in half when there is a space to cut at instead.
  if (from > 0) {
    const space = body.indexOf(" ", from);
    if (space > -1 && space < hit) from = space + 1;
  }
  if (to < body.length) {
    const space = body.lastIndexOf(" ", to);
    if (space > hit + q.length) to = space;
  }

  const head = from > 0 ? "…" : "";
  const tail = to < body.length ? "…" : "";
  return {
    text: head + body.slice(from, to) + tail,
    start: head.length + (hit - from),
    end: head.length + (hit - from) + q.length
  };
}
