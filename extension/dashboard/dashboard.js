import { call } from "../shared/bridge.js";
import { formatRelative } from "../shared/time.js";
import { COLORS } from "../shared/colors.js";
import { downloadMarkdown } from "../export/download.js";
import { ensureDemoHabitat } from "./demo-seed.js";
import { isWaiting, progressLabel, progressOf, reviewItems } from "../shared/progress.js";

if (!globalThis.chrome?.runtime?.id && !globalThis.__LP_BRIDGE) {
  const { handleMessage } = await import("../background/handlers.js");
  globalThis.__LP_BRIDGE = (type, payload) => handleMessage({ type, payload });
}

const TITLES = {
  home: "Home",
  reading: "Reading list",
  bookmarked: "Bookmarks",
  review: "Review"
};

const state = {
  pages: [],
  filter: "home",
  query: "",
  activeId: null
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
  return { waiting, reading, bookmarks, review, awaiting, trail };
}

function render() {
  const pages = state.pages.filter(matchesQuery);
  const { waiting, reading, bookmarks, review, awaiting, trail } = buckets(pages);
  els.heading.textContent = TITLES[state.filter] || "Home";
  els.counts.textContent = `${waiting.length} unread through · ${bookmarks.length} bookmarks · ${awaiting.length} to review`;
  setNavCount("reading", trail.length);
  setNavCount("bookmarked", bookmarks.length);
  setNavCount("review", awaiting.length);

  if (state.filter === "home") {
    els.view.innerHTML = homeHtml({ waiting, reading, bookmarks, awaiting });
  } else if (state.filter === "reading") {
    els.view.innerHTML = listHtml(
      "Reading list",
      "Everything still on the trail. The bar is how far the page was actually scrolled — not whether you clipped it.",
      trail
    );
  } else if (state.filter === "bookmarked") {
    els.view.innerHTML = listHtml("Bookmarks", "Pinned on purpose, independent of how far you read.", bookmarks);
  } else {
    els.view.innerHTML = reviewHtml(review);
  }
  bindView();
}

function setNavCount(filter, n) {
  const el = document.querySelector(`.nav[data-filter="${filter}"] .count`);
  if (el) el.textContent = n ? String(n) : "";
}

function homeHtml({ waiting, reading, bookmarks, awaiting }) {
  return `
    <section class="stats" aria-label="Reading status">
      ${stat("Unread through", waiting.length, "Never reached the end of the page.")}
      ${stat("Mid-scroll", reading.length, "Somewhere between 9% and 89%.")}
      ${stat("To review", awaiting.length, "Your last turn is still waiting.")}
      ${stat("Bookmarks", bookmarks.length, "Kept, even unfinished.")}
    </section>
    ${
      waiting.length
        ? `<section class="section"><div class="push-card">
            <h2>Still not read through.</h2>
            <p>Scroll depth is the reading status. These pages never reached the end — or never really started.</p>
            <div class="push-list">
              ${waiting
                .slice(0, 4)
                .map(
                  (p) =>
                    `<button data-open="${p.id}"><strong>${escapeHtml(p.title)}</strong><br/><span>${escapeHtml(p.domain)} · ${progressLabel(p)} · ${formatRelative(p.lastVisitedAt)}</span></button>`
                )
                .join("")}
            </div>
          </div></section>`
        : ""
    }
    <section class="section">
      <h2>Continue</h2>
      <p class="hint">In the middle of the page. The bar is how far you have actually scrolled.</p>
      <div class="grid">${reading.length ? reading.slice(0, 6).map(pageCard).join("") : `<p class="empty">Nothing mid-read.</p>`}</div>
    </section>
    <section class="section">
      <h2>Review</h2>
      <p class="hint">Comments and asks whose last voice is still yours — they want a pass.</p>
      <div class="grid">${awaiting.length ? awaiting.slice(0, 4).map(reviewCard).join("") : `<p class="empty">No open asks right now.</p>`}</div>
    </section>
    <section class="section">
      <h2>Bookmarks</h2>
      <p class="hint">Kept on purpose, even if the scroll is unfinished.</p>
      <div class="grid">${bookmarks.length ? bookmarks.map(pageCard).join("") : `<p class="empty">Star a page from the reading list.</p>`}</div>
    </section>
  `;
}

function stat(label, value, hint) {
  return `<div class="stat"><strong>${value}</strong><span>${escapeHtml(label)}</span><em>${escapeHtml(hint)}</em></div>`;
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

function pageCard(page) {
  const p = progressOf(page);
  return `
    <article class="card" data-id="${page.id}">
      <div class="domain">${escapeHtml(page.domain)}</div>
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
  els.view.querySelectorAll("[data-open], .card, .review-card").forEach((el) => {
    if (el.dataset.star) return;
    el.onclick = () => openDrawer(el.dataset.open || el.dataset.id);
  });
  els.view.querySelectorAll("[data-star]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.stopPropagation();
      await call("TOGGLE_BOOKMARK", { id: btn.dataset.star });
      await reload();
    };
  });
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

  els.drawer.innerHTML = `
    <button class="ghost" id="close-drawer">Close</button>
    <p class="domain">${escapeHtml(page.domain)}</p>
    <h2>${escapeHtml(page.title)}</h2>
    <p><a href="${page.url}" target="_blank" rel="noreferrer">Open live page</a></p>
    <div class="progress-hero">
      <div class="bar-row">
        <div class="bar" title="${p}%"><span style="width:${p}%"></span></div>
        <span class="pct">${p}%</span>
      </div>
      <p>${progressLabel(page)} · furthest scroll ${p}% · last on page ${formatRelative(page.progress?.updatedAt || page.lastVisitedAt)}</p>
    </div>
    ${page.why ? `<p class="why">${escapeHtml(page.why)}</p>` : ""}
    <div class="actions">
      <button class="ghost" data-act="bookmark">${page.bookmarked ? "Unbookmark" : "Bookmark"}</button>
      <button class="ghost" data-state="parked">Park</button>
      <button class="ghost" data-state="released">Release</button>
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
  if (state.activeId && !els.drawer.hidden) {
    /* keep drawer contents in sync after bookmark/park */
  }
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
