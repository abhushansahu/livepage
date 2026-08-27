import { call } from "../shared/bridge.js";
import { formatRelative } from "../shared/time.js";
import { COLORS } from "../shared/colors.js";
import { downloadMarkdown } from "../export/download.js";
import { ensureDemoHabitat } from "./demo-seed.js";
import { isWaiting, progressLabel, progressOf, reviewItems } from "../shared/progress.js";
import { composeFeed, sourceGlyph, sourceLabel } from "../shared/feed.js";
import {
  allTagsFromPages,
  contentTags,
  normalizeTag,
  pageHasTags,
  parseTagInput,
  sortPages
} from "../shared/tags.js";
import { experimentMeta, firstVisibleFilter, resolveFlags } from "../shared/flags.js";
import { bindVaultFolder, vaultStatus, vaultSupported, writeVault } from "../export/vault.js";

if (location.protocol !== "chrome-extension:" && !globalThis.__LP_BRIDGE) {
  const { handleMessage } = await import("../background/handlers.js");
  globalThis.__LP_BRIDGE = (type, payload) => handleMessage({ type, payload });
}

const TITLES = {
  home: "For you",
  reading: "Reading list",
  bookmarked: "Bookmarks",
  review: "Review",
  saves: "Saves",
  rss: "RSS"
};

const state = {
  pages: [],
  filter: "home",
  query: "",
  sort: "recent",
  tagFilters: [],
  activeId: null,
  feedLimit: 8,
  syncNote: "",
  mind: { signals: {} },
  events: [],
  shownTweets: new Set(),
  settings: {},
  flags: {},
  experiment: { id: "dashboard-density", variant: "A" },
  vault: { bound: false, name: "" }
};

const els = {
  view: document.getElementById("view"),
  counts: document.getElementById("counts"),
  search: document.getElementById("search"),
  drawer: document.getElementById("drawer"),
  heading: document.getElementById("heading"),
  tagBar: document.getElementById("tag-bar"),
  sort: document.getElementById("sort")
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

els.sort.addEventListener("change", () => {
  state.sort = els.sort.value;
  render();
});

document.getElementById("export-waiting").onclick = async () => {
  const waiting = visiblePages().filter(isWaiting);
  if (state.vault.bound) {
    try {
      const result = await writeVault(waiting.length ? waiting : state.pages, state.settings);
      state.syncNote = result.ok
        ? `Wrote ${result.files} files into ${result.name}/${result.folder}. git add / commit / push when you want the other machine.`
        : `Vault write failed (${result.reason}).`;
      render();
      return;
    } catch (error) {
      state.syncNote = String(error.message || error);
    }
  }
  for (const page of waiting.slice(0, 8)) {
    const dump = await call("EXPORT_OBSIDIAN", { id: page.id });
    downloadMarkdown(dump.filename, dump.markdown);
    window.open(dump.uri, "_blank");
  }
};

document.getElementById("sync-saves").onclick = async () => {
  const btn = document.getElementById("sync-saves");
  btn.textContent = "Refreshing…";
  try {
    const result = await call("SYNC_SAVES", { openTabs: Boolean(globalThis.chrome?.tabs) });
    const n = result?.imported || result?.itemCount || 0;
    state.syncNote = n
      ? `Pulled ${n} saved ${n === 1 ? "item" : "items"} from this Chrome profile.`
      : "Nothing new. Stay in this Chrome — the one already logged into X, Reddit, and YouTube — and open those lists. LivePage harvests the session you already have.";
    await reload();
  } catch (error) {
    state.syncNote = String(error.message || error);
    render();
  }
  btn.textContent = "Refresh from this Chrome";
};

document.getElementById("sync-rss").onclick = async () => {
  const btn = document.getElementById("sync-rss");
  btn.textContent = "Syncing…";
  try {
    const result = await call("SYNC_RSS", {});
    const n = result?.itemCount || 0;
    state.syncNote = n
      ? `RSS: ${n} item${n === 1 ? "" : "s"} from your tagged feeds.`
      : "No new RSS items. Add a feed from Settings, or from a page that advertises RSS.";
    await reload();
  } catch (error) {
    state.syncNote = String(error.message || error);
    render();
  }
  btn.textContent = "Sync RSS";
};

document.getElementById("bind-vault").onclick = async () => {
  try {
    const result = await bindVaultFolder();
    if (!result.ok) {
      state.syncNote =
        result.reason === "picker-unavailable"
          ? "This Chrome cannot bind a folder. Dump still downloads markdown you can commit by hand."
          : "Vault folder was not bound.";
      render();
      return;
    }
    await call("SAVE_SETTINGS", {
      vault: { bound: true, name: result.name, boundAt: result.boundAt }
    });
    state.vault = { bound: true, name: result.name, boundAt: result.boundAt };
    state.syncNote = `Bound ${result.name}. That folder should be a git repo (Obsidian vault). Write vault, then commit.`;
    render();
    updateVaultButtons();
  } catch (error) {
    state.syncNote = String(error.message || error);
    render();
  }
};

document.getElementById("write-vault").onclick = async () => {
  try {
    const result = await writeVault(state.pages, state.settings);
    state.syncNote = result.ok
      ? `Wrote ${result.files} files into ${result.name}/${result.folder}. git pull / push on both machines.`
      : `Could not write (${result.reason}). Bind the vault folder first.`;
  } catch (error) {
    state.syncNote = String(error.message || error);
  }
  render();
};

async function boot() {
  try {
    await ensureDemoHabitat(call);
  } catch (error) {
    state.syncNote = `Could not seed the trail: ${error.message || error}`;
  }
  await reload();
  if (!state.pages.length) {
    state.syncNote = `${state.syncNote ? state.syncNote + " " : ""}Trail is empty after boot.`;
  }
}

boot().catch((error) => {
  console.warn("LivePage dashboard failed", error);
  els.view.innerHTML = `<p class="empty">Dashboard failed to boot. ${escapeHtml(error.message || error)}</p>`;
});

function matchesQuery(page) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("#")) {
    return pageHasTags(page, [normalizeTag(q.slice(1))]);
  }
  const hay = [
    page.title,
    page.domain,
    page.why,
    page.importMeta?.source,
    page.importMeta?.author,
    page.parsed?.excerpt,
    ...contentTags(page),
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
  const saves = pages.filter((p) => p.importMeta && p.importMeta.source !== "rss");
  const rss = pages.filter((p) => p.importMeta?.source === "rss");
  return { waiting, reading, bookmarks, review, awaiting, trail, saves, rss };
}

function visiblePages() {
  return sortPages(
    state.pages.filter(matchesQuery).filter((page) => pageHasTags(page, state.tagFilters)),
    state.sort
  );
}

function render() {
  applyChrome();
  const pages = visiblePages();
  const { waiting, bookmarks, review, awaiting, trail, saves, rss } = buckets(pages);
  els.heading.textContent = TITLES[state.filter] || "For you";
  els.counts.textContent = `${waiting.length} unread through · ${saves.length} pulled saves · ${rss.length} rss · ${awaiting.length} to review`;
  setNavCount("reading", trail.length);
  setNavCount("bookmarked", bookmarks.length);
  setNavCount("review", awaiting.length);
  setNavCount("saves", saves.length);
  setNavCount("rss", rss.length);
  renderTagBar(pages);

  if (state.filter === "home") {
    els.view.innerHTML =
      state.flags.dashboardLayout === "lists"
        ? listHtml(
            "Home",
            "Lists-first experiment. Same trail, no timeline chrome.",
            trail
          )
        : homeHtml(pages, awaiting);
  } else if (state.filter === "reading") {
    els.view.innerHTML = listHtml(
      "Reading list",
      "Everything still on the trail. The bar is how far the page was actually scrolled — not whether you clipped it.",
      trail
    );
  } else if (state.filter === "bookmarked") {
    els.view.innerHTML = listHtml(
      "Bookmarks",
      "These stay. Tags and sort are how you find them years later — not another pile to feel guilty about.",
      bookmarks
    );
  } else if (state.filter === "saves") {
    els.view.innerHTML = listHtml(
      "Saves",
      "Harvested from this Chrome while you are already logged into X, Reddit, YouTube, Pocket, HN. No second sign-in.",
      saves
    );
  } else if (state.filter === "rss") {
    els.view.innerHTML = listHtml(
      "RSS",
      "Custom feeds from Settings, or added while browsing. Feed tags copy onto each item.",
      rss
    );
  } else {
    els.view.innerHTML = reviewHtml(review);
  }
  bindView();
}

function applyChrome() {
  const flags = state.flags;
  document.querySelectorAll(".nav").forEach((btn) => {
    const flag = btn.dataset.flag;
    const on = !flag || flags[flag] !== false;
    btn.hidden = !on;
  });
  const visible = firstVisibleFilter(flags, state.filter);
  if (visible !== state.filter) {
    state.filter = visible;
    document.querySelectorAll(".nav").forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.filter === visible);
    });
  }
  document.getElementById("sync-saves").hidden = flags.importSaves === false;
  document.getElementById("sync-rss").hidden = flags.rss === false;
  const meta = experimentMeta(state.experiment);
  const note = document.getElementById("experiment-note");
  note.textContent = `${meta.label}. ${meta.hint} Change it in Settings.`;
  updateVaultButtons();
}

function updateVaultButtons() {
  const bind = document.getElementById("bind-vault");
  const write = document.getElementById("write-vault");
  bind.textContent = state.vault.bound ? `Vault: ${state.vault.name}` : "Bind vault folder";
  write.hidden = !state.vault.bound;
}

function setNavCount(filter, n) {
  const el = document.querySelector(`.nav[data-filter="${filter}"] .count`);
  if (el) el.textContent = n ? String(n) : "";
}

function renderTagBar(pages) {
  const rows = allTagsFromPages(pages).slice(0, 16);
  if (!rows.length && !state.tagFilters.length) {
    els.tagBar.innerHTML = "";
    return;
  }
  els.tagBar.innerHTML = rows
    .map((row) => {
      const on = state.tagFilters.includes(row.tag);
      return `<button type="button" class="tag ${on ? "is-on" : ""}" data-tag="${escapeHtml(row.tag)}">#${escapeHtml(row.tag)} <span>${row.count}</span></button>`;
    })
    .join("");
  els.tagBar.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.onclick = () => {
      const tag = btn.dataset.tag;
      state.tagFilters = state.tagFilters.includes(tag)
        ? state.tagFilters.filter((t) => t !== tag)
        : [...state.tagFilters, tag];
      render();
    };
  });
}

function homeHtml(pages, awaiting) {
  const mind = state.flags.localTweets === false ? { ...state.mind, enabled: false } : state.mind;
  const feed = composeFeed(pages, { mind, events: state.events });
  const shown = feed.slice(0, state.feedLimit);
  return `
    <div class="feed-wrap">
      <header class="feed-head">
        <div>
          <h2>For you</h2>
          <p class="hint">A timeline of waiting pages. Local observations stay off unless you turn them on in Settings. Filter by tag when the pile gets loud.</p>
        </div>
      </header>
      ${state.syncNote ? `<p class="sync-note">${escapeHtml(state.syncNote)}</p>` : ""}
      <div class="feed-stats">
        <span>${awaiting.length} waiting a reply</span>
        <span>${pages.filter((p) => p.importMeta && progressOf(p) <= 8).length} never opened</span>
        <span>${pages.filter((p) => progressOf(p) > 8 && progressOf(p) < 90).length} mid-scroll</span>
        <span>${pages.filter((p) => p.bookmarked).length} bookmarks</span>
      </div>
      <div class="feed">${shown.map(feedPost).join("") || `<p class="empty">Nothing on the trail yet.</p>`}</div>
      ${shown.length < feed.length ? `<button class="more" id="feed-more">Show more</button>` : ""}
    </div>
  `;
}

function listHtml(title, hint, pages) {
  if (!pages.length) {
    return `<section class="section"><h2>${title}</h2><p class="empty">Nothing here yet.${state.syncNote ? ` ${escapeHtml(state.syncNote)}` : ""}</p></section>`;
  }
  return `<section class="section"><h2>${title}</h2><p class="hint">${hint}</p>${state.syncNote ? `<p class="sync-note">${escapeHtml(state.syncNote)}</p>` : ""}<div class="grid">${pages.map(pageCard).join("")}</div></section>`;
}

function reviewHtml(items) {
  if (!items.length) {
    return `<section class="section"><h2>Review</h2><p class="empty">No conversations to review yet. Leave a comment on a page.</p></section>`;
  }
  return `<section class="section"><h2>Review</h2><p class="hint">Re-enter a thread. The last voice is what still wants you.</p><div class="grid">${items.map(reviewCard).join("")}</div></section>`;
}

function feedPost(item) {
  if (item.kind === "local_tweet") return localTweetHtml(item);
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
        ${tagRow(page)}
        <div class="bar-row">
          <div class="bar" title="${p}%"><span style="width:${p}%"></span></div>
          <span class="pct">${p}%</span>
        </div>
        <p class="meta-line">${progressLabel(page)}${page.highlights?.length ? ` · ${page.highlights.length} marks` : ""}${page.bookmarked ? " · ★ bookmark" : ""}</p>
        <div class="tweet-actions">
          <a href="${page.url}" target="_blank" rel="noreferrer" data-live="${page.id}">Open</a>
          <button type="button" data-snooze="${page.id}">Not now</button>
          <button type="button" class="star" data-star="${page.id}">${page.bookmarked ? "★" : "☆"}</button>
        </div>
      </div>
    </article>`;
}

function localTweetHtml(item) {
  const page = item.page;
  const p = page ? progressOf(page) : 0;
  return `
    <article class="tweet local-tweet" data-tweet="${item.id}" data-signal="${item.signal}" data-page="${page?.id || ""}">
      <div class="avatar src-ai">✦</div>
      <div class="tweet-body">
        <p class="tweet-top">
          <strong>LivePage</strong>
          <span>@local</span>
          <span>· observation</span>
        </p>
        <p class="tweet-text">${escapeHtml(item.text)}</p>
        ${
          page
            ? `<div class="related">
                <p class="kicker">${escapeHtml(sourceLabel(page))}</p>
                <p>${escapeHtml(page.title || page.url)}</p>
                <div class="bar-row">
                  <div class="bar"><span style="width:${p}%"></span></div>
                  <span class="pct">${p}%</span>
                </div>
              </div>`
            : ""
        }
        <div class="tweet-actions">
          ${page ? `<button type="button" class="cta" data-cta="${page.id}" data-signal="${item.signal}">${escapeHtml(item.cta || "Open")}</button>` : ""}
          <button type="button" data-like="${item.signal}">♡ Learned</button>
          <button type="button" data-dismiss="${item.signal}">Not this</button>
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
      ${tagRow(page)}
      <div class="bar-row">
        <div class="bar" title="${p}% of the page seen"><span style="width:${p}%"></span></div>
        <span class="pct">${p}%</span>
      </div>
      <div class="meta">
        <span>${progressLabel(page)} · ${page.highlights?.length || 0} marks${page.openedAt ? "" : " · never opened"}</span>
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
      ${tagRow(item.page)}
      <div class="meta"><span>${escapeHtml(item.page.title)}</span><span>${formatRelative(item.last.createdAt)}</span></div>
    </article>`;
}

function tagRow(page) {
  const tags = contentTags(page).slice(0, 6);
  if (!tags.length) return "";
  return `<p class="tags">${tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</p>`;
}

function bindView() {
  els.view.querySelectorAll("[data-open], .card, .review-card, .tweet").forEach((el) => {
    el.onclick = (event) => {
      if (el.classList.contains("local-tweet")) return;
      if (event.target.closest("[data-star], [data-snooze], [data-live], a, [data-cta], [data-like], [data-dismiss]")) return;
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
  els.view.querySelectorAll("[data-cta]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await call("REACT_TWEET", {
        signal: btn.dataset.signal,
        reaction: "act",
        pageId: btn.dataset.cta
      });
      const page = state.pages.find((p) => p.id === btn.dataset.cta);
      if (page?.url) window.open(page.url, "_blank", "noreferrer");
      openDrawer(btn.dataset.cta);
    };
  });
  els.view.querySelectorAll("[data-like]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await call("REACT_TWEET", { signal: btn.dataset.like, reaction: "like" });
      btn.textContent = "♡ Got it";
    };
  });
  els.view.querySelectorAll("[data-dismiss]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await call("REACT_TWEET", { signal: btn.dataset.dismiss, reaction: "dismiss" });
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
    <label class="tag-edit">Tags
      <input id="page-tags" value="${escapeHtml((page.tags || []).join(", "))}" placeholder="design, later, systems" />
    </label>
    <p class="tags derived">${contentTags(page)
      .map((tag) => `<span>#${escapeHtml(tag)}</span>`)
      .join("")}</p>
    <div class="actions">
      <button class="ghost" data-act="bookmark">${page.bookmarked ? "Unbookmark" : "Bookmark"}</button>
      <button class="ghost" data-state="parked">Park</button>
      <button class="ghost" data-state="released">Release</button>
      <button class="ghost" data-act="snooze">Not now</button>
      <button class="solid" data-act="obsidian">${state.vault.bound ? "Write to vault" : "Dump to Obsidian"}</button>
      <button class="ghost" data-act="delete">Remove</button>
    </div>
    <h3>Review</h3>
    ${threads || "<p class='excerpt'>No comments to review yet.</p>"}
  `;
  els.drawer.querySelector("#close-drawer").onclick = () => {
    els.drawer.hidden = true;
  };
  const tagInput = els.drawer.querySelector("#page-tags");
  const saveTags = async () => {
    await call("SET_TAGS", { id: page.id, tags: parseTagInput(tagInput.value) });
    await reload();
    openDrawer(page.id);
  };
  tagInput.addEventListener("change", saveTags);
  tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveTags();
    }
  });
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
    if (state.vault.bound) {
      const latest = (await call("LIST_PAGES")) || state.pages;
      const result = await writeVault(latest, state.settings);
      state.syncNote = result.ok
        ? `Wrote vault (${result.files} files). git commit when you want both machines.`
        : `Vault write failed (${result.reason}).`;
      render();
      return;
    }
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
  try {
    state.settings = (await call("GET_SETTINGS")) || {};
    const resolved = resolveFlags(state.settings);
    state.flags = resolved.flags;
    state.experiment = resolved.experiment;
    state.mind = (await call("GET_MIND")) || { signals: {} };
    if (!state.flags.localTweets) state.mind.enabled = false;
    state.events = (await call("LIST_EVENTS")) || [];
  } catch {
    state.mind = { signals: {} };
    state.events = [];
    const resolved = resolveFlags(state.settings);
    state.flags = resolved.flags;
    state.experiment = resolved.experiment;
  }
  try {
    if (await vaultSupported()) {
      const status = await vaultStatus();
      state.vault = status;
    }
  } catch {
    /* demo / missing store */
  }
  render();
  markTweetsShown();
}

async function markTweetsShown() {
  const nodes = [...els.view.querySelectorAll(".local-tweet[data-signal]")];
  for (const el of nodes) {
    const signal = el.dataset.signal;
    if (!signal || state.shownTweets.has(signal)) continue;
    state.shownTweets.add(signal);
    try {
      await call("REACT_TWEET", { signal, reaction: "shown" });
    } catch {
      /* ignore */
    }
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
