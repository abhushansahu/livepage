import { call } from "../shared/bridge.js";
import { formatRelative } from "../shared/time.js";
import { COLORS } from "../shared/colors.js";
import { downloadMarkdown } from "../export/download.js";
import { ensureDemoHabitat } from "./demo-seed.js";
import { isWaiting, progressLabel, progressOf, reviewItems } from "../shared/progress.js";
import { feedItems, sourceGlyph, sourceLabel } from "../shared/feed.js";

if (!globalThis.chrome?.runtime?.id && !globalThis.__LP_BRIDGE) {
  const { handleMessage } = await import("../background/handlers.js");
  globalThis.__LP_BRIDGE = (type, payload) => handleMessage({ type, payload });
}

const TITLES = {
  home: "For you",
  reading: "Reading list",
  bookmarked: "Bookmarks",
  review: "Review",
  saves: "Saves"
};

const state = {
  pages: [],
  filter: "home",
  query: "",
  activeId: null,
  feedLimit: 8,
  syncNote: ""
};

const els = {
  view: document.getElementById("view"),
  counts: document.getElementById("counts"),
  search: document.getElementById("search"),
  drawer: document.getElementById("drawer"),
  heading: document.getElementById("heading")
};

document.querySelectorAll(".nav").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("is-on", b === btn));
    state.filter = btn.dataset.filter;
    state.feedLimit = 8;
    render();
  };
});

els.search.addEventListener("input", () => {
  state.query = els.search.value;
  render();
});

document.getElementById("export-waiting").onclick = async () => {
  const waiting = state.pages.filter(isWaiting);
  for (const page of waiting.slice(0, 8)) {
    const dump = await call("EXPORT_OBSIDIAN", { id: page.id });
    downloadMarkdown(dump.filename, dump.markdown);
    window.open(dump.uri, "_blank");
  }
};

document.getElementById("sync-saves").onclick = async () => {
  const btn = document.getElementById("sync-saves");
  btn.textContent = "Pulling…";
  try {
    const result = await call("SYNC_SAVES", { openTabs: Boolean(globalThis.chrome?.tabs) });
    const n = result?.imported || result?.itemCount || 0;
    state.syncNote = n
      ? `Pulled ${n} saved ${n === 1 ? "item" : "items"}.`
      : "Nothing new. Open X bookmarks, Reddit saved, or YouTube Watch Later while logged in — LivePage harvests them as you scroll.";
    await reload();
  } catch (error) {
    state.syncNote = String(error.message || error);
    render();
  }
  btn.textContent = "Pull saves";
};

boot();

async function boot() {
  await ensureDemoHabitat(call);
  await reload();
}

function matchesQuery(page) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    page.title,
    page.domain,
    page.why,
    page.importMeta?.source,
    page.importMeta?.author,
    page.parsed?.excerpt,
    ...(page.highlights || []).map((h) => h.text),
    ...(page.threads || []).flatMap((t) => (t.messages || []).map((m) => m.content))
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

function buckets(pages) {
  const waiting = pages.filter(isWaiting);
  const reading = pages.filter((p) => progressOf(p) > 8 && progressOf(p) < 90 && p.readState !== "released");
  const bookmarks = pages.filter((p) => p.bookmarked);
  const review = reviewItems(pages);
  const awaiting = review.filter((r) => r.awaiting);
  const trail = pages.filter((p) => p.readState !== "released");
  const saves = pages.filter((p) => p.importMeta);
  return { waiting, reading, bookmarks, review, awaiting, trail, saves };
}

function render() {
  const pages = state.pages.filter(matchesQuery);
  const { waiting, bookmarks, review, awaiting, trail, saves } = buckets(pages);
  els.heading.textContent = TITLES[state.filter] || "For you";
  els.counts.textContent = `${waiting.length} unread through · ${saves.length} pulled saves · ${awaiting.length} to review`;
  setNavCount("reading", trail.length);
  setNavCount("bookmarked", bookmarks.length);
  setNavCount("review", awaiting.length);
  setNavCount("saves", saves.length);

  if (state.filter === "home") {
    els.view.innerHTML = homeHtml(pages, awaiting);
  } else if (state.filter === "reading") {
    els.view.innerHTML = listHtml(
      "Reading list",
      "Everything still on the trail. The bar is how far the page was actually scrolled — not whether you clipped it.",
      trail
    );
  } else if (state.filter === "bookmarked") {
    els.view.innerHTML = listHtml("Bookmarks", "Pinned on purpose, independent of how far you read.", bookmarks);
  } else if (state.filter === "saves") {
    els.view.innerHTML = listHtml(
      "Saves",
      "Pulled from X bookmarks, Reddit saved, YouTube Watch Later, and similar lists. They stay here until you actually open them.",
      saves
    );
  } else {
    els.view.innerHTML = reviewHtml(review);
  }
  bindView();
}

function setNavCount(filter, n) {
  const el = document.querySelector(`.nav[data-filter="${filter}"] .count`);
  if (el) el.textContent = n ? String(n) : "";
}

function homeHtml(pages, awaiting) {
  const feed = feedItems(pages);
  const shown = feed.slice(0, state.feedLimit);
  return `
    <div class="feed-wrap">
      <header class="feed-head">
        <div>
          <h2>For you</h2>
          <p class="hint">Scroll it like a timeline. Untouched Watch Later, X bookmarks, Reddit saves, half-read pages, and asks still waiting keep coming back.</p>
        </div>
      </header>
      ${state.syncNote ? `<p class="sync-note">${escapeHtml(state.syncNote)}</p>` : ""}
      <div class="feed-stats">
        <span>${awaiting.length} waiting a reply</span>
        <span>${pages.filter((p) => p.importMeta && progressOf(p) <= 8).length} never opened</span>
        <span>${pages.filter((p) => progressOf(p) > 8 && progressOf(p) < 90).length} mid-scroll</span>
      </div>
      <div class="feed">${shown.map(feedPost).join("") || `<p class="empty">Nothing on the trail yet.</p>`}</div>
      ${shown.length < feed.length ? `<button class="more" id="feed-more">Show more</button>` : ""}
    </div>
  `;
}

function listHtml(title, hint, pages) {
  if (!pages.length) {
    return `<section class="section"><h2>${title}</h2><p class="empty">Nothing here yet.</p></section>`;
  }
  return `<section class="section"><h2>${title}</h2><p class="hint">${hint}</p><div class="grid">${pages.map(pageCard).join("")}</div></section>`;
}

function reviewHtml(items) {
  if (!items.length) {
    return `<section class="section"><h2>Review</h2><p class="empty">No conversations to review yet. Leave a comment on a page.</p></section>`;
  }
  return `<section class="section"><h2>Review</h2><p class="hint">Re-enter a thread. The last voice is what still wants you.</p><div class="grid">${items.map(reviewCard).join("")}</div></section>`;
}

function feedPost(item) {
  const page = item.page;
  const p = progressOf(page);
  const review = item.review;
  return `
    <article class="tweet" data-id="${page.id}">
      <div class="avatar src-${page.importMeta?.source || "live"}">${sourceGlyph(page)}</div>
      <div class="tweet-body">
        <p class="tweet-top">
          <strong>${escapeHtml(sourceLabel(page))}</strong>
          <span>${escapeHtml(page.importMeta?.author || page.domain)}</span>
          <span>· ${formatRelative(page.importMeta?.importedAt || page.lastVisitedAt || page.createdAt)}</span>
        </p>
        <p class="reason">${escapeHtml(item.reason)}</p>
        <h3>${escapeHtml(page.title || page.url)}</h3>
        ${
          review
            ? `<q>${escapeHtml(clip(review.highlight?.text || "", 140))}</q>
               <p class="excerpt"><strong>You:</strong> ${escapeHtml(clip(review.last.content, 160))}</p>`
            : `<p class="excerpt">${escapeHtml(clip(page.parsed?.excerpt || page.why || "", 200))}</p>`
        }
        <div class="bar-row">
          <div class="bar" title="${p}%"><span style="width:${p}%"></span></div>
          <span class="pct">${p}%</span>
        </div>
        <p class="meta-line">${progressLabel(page)}${page.highlights?.length ? ` · ${page.highlights.length} marks` : ""}</p>
        <div class="tweet-actions">
          <a href="${page.url}" target="_blank" rel="noreferrer" data-live="${page.id}">Open</a>
          <button type="button" data-snooze="${page.id}">Not now</button>
          <button type="button" class="star" data-star="${page.id}">${page.bookmarked ? "★" : "☆"}</button>
        </div>
      </div>
    </article>`;
}

function pageCard(page) {
  const p = progressOf(page);
  return `
    <article class="card" data-id="${page.id}">
      <div class="domain">${escapeHtml(sourceLabel(page))} · ${escapeHtml(page.domain)}</div>
      <h3>${escapeHtml(page.title || page.url)}</h3>
      <p class="excerpt">${escapeHtml(clip(page.parsed?.excerpt || page.why || "No parsed excerpt yet.", 140))}</p>
      <div class="bar-row">
        <div class="bar" title="${p}% of the page seen"><span style="width:${p}%"></span></div>
        <span class="pct">${p}%</span>
      </div>
      <div class="meta">
        <span>${progressLabel(page)} · ${page.highlights?.length || 0} marks</span>
        <button class="star" data-star="${page.id}" title="Bookmark">${page.bookmarked ? "★" : "☆"}</button>
      </div>
    </article>`;
}

function reviewCard(item) {
  return `
    <article class="review-card" data-id="${item.page.id}">
      <div class="kicker">${escapeHtml(item.page.domain)} · ${item.awaiting ? "awaiting reply" : "last turn"}</div>
      <q>${escapeHtml(clip(item.highlight?.text || "", 120))}</q>
      <p class="excerpt"><strong>${item.last.role === "agent" ? "Agent" : "You"}:</strong> ${escapeHtml(clip(item.last.content, 140))}</p>
      <div class="meta"><span>${escapeHtml(item.page.title)}</span><span>${formatRelative(item.last.createdAt)}</span></div>
    </article>`;
}

function bindView() {
  els.view.querySelectorAll("[data-open], .card, .review-card, .tweet").forEach((el) => {
    el.onclick = (event) => {
      if (event.target.closest("[data-star], [data-snooze], [data-live], a")) return;
      openDrawer(el.dataset.open || el.dataset.id);
    };
  });
  els.view.querySelectorAll("[data-star]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await call("TOGGLE_BOOKMARK", { id: btn.dataset.star });
      await reload();
    };
  });
  els.view.querySelectorAll("[data-snooze]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await call("SNOOZE_PAGE", { id: btn.dataset.snooze, hours: 48 });
      await reload();
    };
  });
  const more = document.getElementById("feed-more");
  if (more) {
    more.onclick = () => {
      state.feedLimit += 8;
      render();
    };
  }
}

async function openDrawer(id) {
  const page = await call("GET_PAGE", { id });
  if (!page) return;
  state.activeId = id;
  els.drawer.hidden = false;
  const p = progressOf(page);
  const threads = (page.threads || [])
    .map((thread) => {
      const highlight = (page.highlights || []).find((h) => h.id === thread.highlightId);
      const color = COLORS[highlight?.color]?.fill || "#F6E27A";
      const last = thread.messages?.[thread.messages.length - 1];
      return `
        <section class="thread">
          <q style="border-left: 3px solid ${color}; padding-left: 8px">${escapeHtml(highlight?.text || "")}</q>
          <p>${escapeHtml(thread.branchLabel || "main")}${thread.parentId ? " · forked" : ""}${last?.role === "user" ? " · needs review" : ""}</p>
          ${(thread.messages || [])
            .map(
              (m) =>
                `<p><strong>${m.role === "agent" ? `Agent (${m.agent})` : "You"}:</strong> ${escapeHtml(m.content)}</p>`
            )
            .join("")}
        </section>`;
    })
    .join("");

  const source = page.importMeta
    ? `<p class="why">${escapeHtml(page.importMeta.kind || "saved")} from ${escapeHtml(sourceLabel(page))}${page.importMeta.author ? ` · ${escapeHtml(page.importMeta.author)}` : ""}</p>`
    : "";

  els.drawer.innerHTML = `
    <button class="ghost" id="close-drawer">Close</button>
    <p class="domain">${escapeHtml(sourceLabel(page))} · ${escapeHtml(page.domain)}</p>
    <h2>${escapeHtml(page.title)}</h2>
    <p><a href="${page.url}" target="_blank" rel="noreferrer">Open live page</a></p>
    <div class="progress-hero">
      <div class="bar-row">
        <div class="bar" title="${p}%"><span style="width:${p}%"></span></div>
        <span class="pct">${p}%</span>
      </div>
      <p>${progressLabel(page)} · furthest scroll ${p}% · last on page ${page.openedAt ? formatRelative(page.progress?.updatedAt || page.lastVisitedAt) : "never"}</p>
    </div>
    ${source}
    ${page.why ? `<p class="why">${escapeHtml(page.why)}</p>` : ""}
    <div class="actions">
      <button class="ghost" data-act="bookmark">${page.bookmarked ? "Unbookmark" : "Bookmark"}</button>
      <button class="ghost" data-state="parked">Park</button>
      <button class="ghost" data-state="released">Release</button>
      <button class="ghost" data-act="snooze">Not now</button>
      <button class="solid" data-act="obsidian">Dump to Obsidian</button>
      <button class="ghost" data-act="delete">Remove</button>
    </div>
    <h3>Review</h3>
    ${threads || "<p class='excerpt'>No comments to review yet.</p>"}
  `;
  els.drawer.querySelector("#close-drawer").onclick = () => {
    els.drawer.hidden = true;
  };
  els.drawer.querySelectorAll("[data-state]").forEach((btn) => {
    btn.onclick = async () => {
      await call("SET_READ_STATE", { id: page.id, readState: btn.dataset.state });
      await reload();
      openDrawer(page.id);
    };
  });
  els.drawer.querySelector("[data-act='bookmark']").onclick = async () => {
    await call("TOGGLE_BOOKMARK", { id: page.id });
    await reload();
    openDrawer(page.id);
  };
  els.drawer.querySelector("[data-act='snooze']").onclick = async () => {
    await call("SNOOZE_PAGE", { id: page.id, hours: 48 });
    els.drawer.hidden = true;
    await reload();
  };
  els.drawer.querySelector("[data-act='obsidian']").onclick = async () => {
    const dump = await call("EXPORT_OBSIDIAN", { id: page.id });
    try {
      await navigator.clipboard.writeText(dump.markdown);
    } catch {
      /* ignore */
    }
    downloadMarkdown(dump.filename, dump.markdown);
    window.open(dump.uri, "_blank");
  };
  els.drawer.querySelector("[data-act='delete']").onclick = async () => {
    await call("DELETE_PAGE", { id: page.id });
    els.drawer.hidden = true;
    await reload();
  };
}

async function reload() {
  state.pages = (await call("LIST_PAGES")) || [];
  render();
}

function clip(text, n) {
  const s = String(text || "");
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
