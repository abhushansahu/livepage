import { call } from "../shared/bridge.js";
import { formatRelative } from "../shared/time.js";
import { COLORS, COLOR_IDS } from "../shared/colors.js";
import { downloadMarkdown } from "../export/download.js";
import { ensureDemoHabitat } from "./demo-seed.js";
import { isWaiting, progressLabel, progressOf, reviewItems } from "../shared/progress.js";
import { anchorItems } from "../shared/anchors.js";
import { highlightMatches, pageMatchesQuery } from "../shared/search.js";
import { cssEscape } from "../parse/quote.js";
import { viewerUrlFor } from "../pdf/route.js";
import { renderMessage } from "../shared/markdown.js";
import { composeFeed, sourceGlyph, sourceLabel } from "../shared/feed.js";
import { sourceColor, sourceKey } from "../shared/source-meta.js";
import { icon, sourceIcon } from "../shared/icons.js";
import { isBookmark, isReadingList, isRss, isSave } from "../shared/lists.js";
import {
  displayTags,
  filterBarTags,
  normalizeTag,
  pageHasTags,
  parseTagInput,
  sortPages
} from "../shared/tags.js";
import { experimentMeta, firstVisibleFilter, navItems, resolveFlags } from "../shared/flags.js";
import { applyTheme, watchTheme } from "../shared/theme.js";
import { bindVaultFolder, vaultStatus, vaultSupported, writeVault } from "../export/vault.js";

/**
 * Where "open this page" actually goes.
 *
 * A PDF's record is keyed on the PDF's own URL, which is right — but opening
 * that URL hands the document to Chrome's viewer, where LivePage is not, and
 * the reader sees a bare PDF and concludes their highlights are gone. Route it
 * back through our own viewer instead.
 */
function liveUrlFor(page, hash = "") {
  if (!page?.url) return "";
  const base = page.kind === "pdf" ? viewerUrlFor(page.url) || page.url : page.url;
  if (!hash) return base;
  const url = new URL(base);
  url.hash = hash;
  return url.href;
}

if (location.protocol !== "chrome-extension:" && !globalThis.__LP_BRIDGE) {
  const { handleMessage } = await import("../background/handlers.js");
  globalThis.__LP_BRIDGE = (type, payload) => handleMessage({ type, payload });
}

/** Each room owns one hue, so nav, section rule, and counts all read as a set. */
const ROOMS = {
  home: { title: "For you", icon: "spark", color: "#6d28d9" },
  reading: { title: "Reading list", icon: "reading", color: "#1c7ed6" },
  bookmarked: { title: "Bookmarks", icon: "star", color: "#e6a100" },
  saves: { title: "Saves", icon: "saves", color: "#0ca678" },
  rss: { title: "RSS", icon: "rss", color: "#e8590c" },
  review: { title: "Review", icon: "review", color: "#e03131" }
};

const ROOM_HINTS = {
  home: "Scored by what is still waiting on you — not everything you have browsed.",
  reading: "Pages you queued on purpose — popup, Alt+Shift+R, or right-click.",
  bookmarked: "Starred pages. Separate from the reading list and from harvested Saves.",
  saves: "Harvested YouTube Watch Later, Reddit saved, and X bookmarks.",
  rss: "Custom feeds from Settings, or added while browsing.",
  review: "Threads where the last voice was yours."
};

const state = {
  pages: [],
  filter: "home",
  query: "",
  searchMode: "pages",
  sort: "recent",
  tagFilters: [],
  activeId: null,
  feedPages: 1,
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
  sort: document.getElementById("sort"),
  searchMode: document.getElementById("search-mode"),
  nav: document.getElementById("nav"),
  rail: document.getElementById("rail")
};

els.search.addEventListener("input", () => {
  state.query = els.search.value;
  render();
});

els.searchMode?.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.onclick = () => {
    state.searchMode = btn.dataset.mode;
    render();
  };
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
    const result = await call("SYNC_SAVES", { openTabs: true });
    const twitter = (result?.reports || []).find((row) => row.source === "twitter");
    const n = result?.imported || result?.itemCount || 0;
    if (twitter?.status === "login") {
      state.syncNote =
        "X is asking for login in this Chrome profile. Stay signed in, then Refresh again.";
    } else if (n) {
      const x = twitter?.items ? ` X ${twitter.items}.` : "";
      state.syncNote = `Pulled ${n} saved ${n === 1 ? "item" : "items"} from YouTube, Reddit, and X.${x}`;
    } else if (twitter?.status === "no-tab") {
      state.syncNote =
        "YouTube/Reddit were checked. X needs a bookmarks tab in this Chrome profile — Refresh opens it; stay logged in.";
    } else {
      state.syncNote = twitter?.ok
        ? "Nothing new from YouTube, Reddit, or X bookmarks."
        : "Nothing new. Refresh flashes X bookmarks so LivePage can catch the list — stay logged in, then try again.";
    }
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
    if (error?.name === "AbortError" || /abort/i.test(String(error.message || error))) {
      state.syncNote = "Vault bind cancelled.";
    } else {
      state.syncNote = String(error.message || error);
    }
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

watchTheme((next) => {
  state.settings = { ...state.settings, ...next };
  applyTheme(state.settings.pageTheme);
});

boot().catch((error) => {
  console.warn("LivePage dashboard failed", error);
  els.view.innerHTML = `<p class="empty">Dashboard failed to boot. ${escapeHtml(error.message || error)}</p>`;
});

function matchesQuery(page) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  // A bare tag is a filter, not a phrase — there is nothing in it to match a
  // passage against.
  if (q.startsWith("#")) {
    return pageHasTags(page, [normalizeTag(q.slice(1))]);
  }
  return pageMatchesQuery(page, q);
}

function tagQuery() {
  return state.query.trim().startsWith("#");
}

/** Passage search only makes sense with words to look for. */
function passagesAvailable() {
  return Boolean(state.query.trim()) && !tagQuery();
}

function passageResults() {
  if (!passagesAvailable()) return [];
  // visiblePages has already applied the tag chips, so the two filters compose
  // without passage search knowing anything about tags.
  return highlightMatches(visiblePages(), state.query);
}

function buckets(pages) {
  const waiting = pages.filter(isWaiting);
  const readingList = pages.filter(isReadingList);
  const bookmarks = pages.filter(isBookmark);
  const review = reviewItems(pages);
  const awaiting = review.filter((r) => r.awaiting);
  const anchors = anchorItems(pages);
  const trail = pages.filter((p) => p.readState !== "released");
  const saves = pages.filter(isSave);
  const rss = pages.filter(isRss);
  return { waiting, readingList, bookmarks, review, awaiting, anchors, trail, saves, rss };
}

function visiblePages() {
  return sortPages(
    state.pages.filter(matchesQuery).filter((page) => pageHasTags(page, state.tagFilters)),
    state.sort
  );
}

function render() {
  const flags = state.flags;
  document.body.dataset.layout = flags.dashboardLayout || "compact";
  state.filter = firstVisibleFilter(flags, state.filter);

  const pages = visiblePages();
  const bucket = buckets(pages);
  const { waiting, review, awaiting, trail, saves, rss } = bucket;
  const homeFeed = composeHome(pages);

  applyChrome(bucket, homeFeed.length);
  els.heading.textContent = ROOMS[state.filter]?.title || "For you";
  els.counts.textContent = isPortal()
    ? `${waiting.length} unread · ${saves.length} saves · ${awaiting.length} review${bucket.anchors.length ? ` · ${bucket.anchors.length} unanchored` : ""}`
    : `${waiting.length} unread through · ${saves.length} pulled saves · ${rss.length} rss · ${awaiting.length} to review`;
  renderTagBar(pages);

  const room = state.filter;
  const passages = state.searchMode === "passages" ? passageResults() : [];
  renderSearchMode(passages);
  if (state.searchMode === "passages" && passagesAvailable()) {
    els.view.innerHTML = passagesHtml(passages);
  } else if (room === "review") {
    const body = isPortal() ? portalRowsHtml(room, review) : reviewHtml(review);
    els.view.innerHTML = body + anchorHtml(bucket.anchors);
  } else if (room === "home" && isPortal()) {
    els.view.innerHTML = portalHomeHtml(homeFeed);
  } else {
    const rows = {
      home: trail,
      reading: bucket.readingList,
      bookmarked: bucket.bookmarks,
      saves,
      rss
    }[room];
    if (isPortal()) {
      els.view.innerHTML = portalRowsHtml(room, rows);
    } else if (room !== "home") {
      els.view.innerHTML = listHtml(ROOMS[room].title, ROOM_HINTS[room], rows);
    } else {
      els.view.innerHTML =
        flags.dashboardLayout === "lists"
          ? listHtml("Home", "Lists-first experiment. Same trail, no timeline chrome.", trail)
          : homeHtml(homeFeed, pages, awaiting);
    }
  }
  bindView();
  renderRail(pages, bucket);
}

function applyChrome(bucket, homeCount) {
  const flags = state.flags;
  document.body.classList.toggle(
    "drawer-open",
    Boolean(state.activeId) && els.drawer && !els.drawer.hidden
  );
  renderNav({
    reading: bucket.readingList.length,
    bookmarked: bucket.bookmarks.length,
    review: bucket.awaiting.length,
    saves: bucket.saves.length,
    rss: bucket.rss.length,
    home: homeCount
  });
  document.getElementById("sync-saves").hidden = flags.importSaves === false;
  document.getElementById("sync-rss").hidden = flags.rss === false;
  const meta = experimentMeta(state.experiment);
  const note = document.getElementById("experiment-note");
  note.textContent = `${meta.label}. ${meta.hint} Change it in Settings.`;
  updateVaultButtons();
}

function renderNav(counts) {
  els.nav.innerHTML = navItems(state.flags)
    .map((item) => {
      const room = ROOMS[item.id];
      const n = counts[item.id] || 0;
      return `
        <button type="button" class="nav ${state.filter === item.id ? "is-on" : ""}" data-filter="${item.id}" style="--room:${room.color}">
          <span class="nav-ico">${icon(room.icon, { size: 17 })}</span>
          <span class="nav-label">${room.title}</span>
          <span class="count">${n || ""}</span>
        </button>`;
    })
    .join("");
  els.nav.querySelectorAll(".nav").forEach((btn) => {
    btn.onclick = () => {
      state.filter = btn.dataset.filter;
      state.feedPages = 1;
      render();
    };
  });
}

function updateVaultButtons() {
  const bind = document.getElementById("bind-vault");
  const write = document.getElementById("write-vault");
  bind.textContent = state.vault.bound ? `Vault: ${state.vault.name}` : "Bind vault folder";
  write.hidden = !state.vault.bound;
}

/**
 * Tags live in the left column next to the rooms, because both answer "what am
 * I looking at". Only the top few fit, so an active filter is pinned in even
 * when its count would drop it off the list.
 */
function renderTagBar(pages) {
  const all = filterBarTags(pages);
  const rows = all.slice(0, 14);
  for (const tag of state.tagFilters) {
    if (rows.some((row) => row.tag === tag)) continue;
    rows.push(all.find((row) => row.tag === tag) || { tag, count: 0 });
  }
  const label = document.getElementById("tag-label");
  if (label) label.hidden = !rows.length;
  if (!rows.length) {
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

function roomHead(roomId, count) {
  const room = ROOMS[roomId];
  return `
    <header class="room-head" style="--room:${room.color}">
      <div class="room-line">
        <span class="room-ico">${icon(room.icon, { size: 15 })}</span>
        <h2>${room.title}</h2>
        <span class="room-count">${count}</span>
      </div>
      <p class="room-hint">${ROOM_HINTS[roomId]}</p>
    </header>`;
}

function syncNoteHtml() {
  return state.syncNote ? `<p class="sync-note">${escapeHtml(state.syncNote)}</p>` : "";
}

function portalRowsHtml(roomId, items) {
  const head = roomHead(roomId, items.length);
  const note = syncNoteHtml();
  if (!items.length) {
    return `${head}${note}<p class="empty">Nothing here yet.</p>`;
  }
  const rows =
    roomId === "review"
      ? items.map((item) => denseReviewRow(item)).join("")
      : items.map((page) => denseRow(page)).join("");
  return `${head}${note}<div class="rows">${rows}</div>`;
}

function composeHome(pages) {
  const mind = state.flags.localTweets === false ? { ...state.mind, enabled: false } : state.mind;
  return composeFeed(pages, { mind, events: state.events });
}

/**
 * For you is the scored feed, never the raw trail — a page you browsed once and
 * finished has no business here. Same composeFeed as the timeline layout, just
 * rendered as tiles across the full width.
 */
function portalHomeHtml(feed) {
  const head = roomHead("home", feed.length);
  const note = syncNoteHtml();
  if (!feed.length) {
    return `${head}${note}<p class="empty">Nothing is waiting on you. Everything you saved has been opened, finished, or released.</p>`;
  }
  const shown = feed.slice(0, state.feedPages * feedStep());
  const more =
    shown.length < feed.length
      ? `<button class="more" id="feed-more">Show ${feed.length - shown.length} more</button>`
      : "";
  return `${head}${note}<div class="rows">${shown.map(feedTile).join("")}</div>${more}`;
}

function feedTile(item) {
  if (item.kind === "local_tweet") return localTweetTile(item);
  return denseRow(item.page, item);
}

function localTweetTile(item) {
  const page = item.page;
  return `
    <article class="row local-tweet is-observation" data-tweet="${item.id}" data-signal="${item.signal}" style="--accent:${ROOMS.home.color}">
      <span class="row-ico">${icon("spark", { size: 15 })}</span>
      <div class="row-main">
        <p class="row-reason">LivePage · local observation</p>
        <p class="row-title">${escapeHtml(item.text)}</p>
        ${page ? `<p class="row-sub"><span class="dom">${escapeHtml(page.title || page.url)}</span></p>` : ""}
        <div class="row-pills">
          ${page ? `<button type="button" class="pill" data-cta="${page.id}" data-signal="${item.signal}">${escapeHtml(item.cta || "Open")}</button>` : ""}
          <button type="button" class="pill" data-like="${item.signal}">Learned</button>
          <button type="button" class="pill" data-dismiss="${item.signal}">Not this</button>
        </div>
      </div>
    </article>`;
}

/** unread / mid-scroll / finished each get their own colour so a wall of tiles scans. */
function stateChip(page) {
  const p = progressOf(page);
  if (!page.openedAt) return { label: "new", tone: "new" };
  if (p >= 90) return { label: "done", tone: "done" };
  if (p > 8) return { label: `${p}%`, tone: "mid" };
  return { label: "unread", tone: "unread" };
}

/**
 * One row says: what it is, where it came from, how far you got. Progress is a
 * hairline on the edge rather than a bar competing with the title, and the two
 * actions stay out of the way until the row is hovered or focused.
 */
function denseRow(page, item = null) {
  const p = progressOf(page);
  const chip = stateChip(page);
  const review = item?.review;
  const started = p > 8 && p < 90;
  return `
    <article class="row ${state.activeId === page.id ? "is-on" : ""}" data-id="${page.id}" style="--accent:${sourceColor(page)}">
      <span class="row-ico">${sourceIcon(sourceKey(page), { size: 15 })}</span>
      <div class="row-main">
        ${item?.reason ? `<p class="row-reason">${escapeHtml(item.reason)}</p>` : ""}
        <p class="row-title">${escapeHtml(page.title || page.url)}</p>
        ${review ? `<q class="row-quote">${escapeHtml(clip(review.highlight?.text || "", 110))}</q>` : ""}
        <p class="row-sub">
          <span class="dom">${escapeHtml(page.domain)}</span>
          <span class="chip ${chip.tone}">${chip.label}</span>
          ${page.highlights?.length ? `<span class="chip marks">${page.highlights.length} marks</span>` : ""}
        </p>
      </div>
      <div class="row-actions">
        <button type="button" class="act ${page.inReadingList ? "is-on" : ""}" data-reading="${page.id}" title="${page.inReadingList ? "In reading list" : "Add to reading list"}" aria-label="Reading list">${icon("reading", { size: 14 })}</button>
        <button type="button" class="act star ${page.bookmarked ? "is-on" : ""}" data-star="${page.id}" title="${page.bookmarked ? "Bookmarked" : "Bookmark"}" aria-label="Bookmark">${icon("star", { size: 14 })}</button>
      </div>
      ${started ? `<span class="row-progress" style="width:${p}%"></span>` : ""}
    </article>`;
}

function denseReviewRow(item) {
  return `
    <article class="row is-review" data-id="${item.page.id}" style="--accent:${ROOMS.review.color}">
      <span class="row-ico">${icon("review", { size: 15 })}</span>
      <div class="row-main">
        <p class="row-title">${escapeHtml(clip(item.highlight?.text || item.page.title || "", 90))}</p>
        <p class="row-sub">
          ${item.awaiting ? `<span class="chip waiting">awaiting</span>` : ""}
          <span class="src">${item.last.role === "agent" ? "Agent" : "You"}</span>
          <span class="dom">${escapeHtml(clip(item.last.content, 90))}</span>
        </p>
      </div>
    </article>`;
}

function isPortal() {
  return state.flags.dashboardLayout === "compact";
}

/** A tile grid shows several rows at once, so it pages in bigger bites. */
function feedStep() {
  return isPortal() ? 24 : 8;
}

function homeHtml(feed, pages, awaiting) {
  const shown = feed.slice(0, state.feedPages * feedStep());
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

/**
 * Highlights whose anchor is in doubt.
 *
 * The dashboard has no live page, so it cannot go looking — it can only report
 * what the last visit recorded. Repair needs the passage in front of you, so
 * the only thing to do from here is open the page.
 */
function anchorHtml(items) {
  if (!items?.length) return "";
  const lost = items.filter((item) => !item.weak);
  const weak = items.filter((item) => item.weak);
  const section = (title, hint, rows) =>
    rows.length
      ? `<section class="section"><h2>${title}</h2><p class="hint">${hint}</p><div class="grid">${rows
          .map(anchorCard)
          .join("")}</div></section>`
      : "";
  return (
    section(
      "Needs re-anchoring",
      "These pages changed under your highlights. Open one and re-attach it where the passage lives now.",
      lost
    ) +
    section(
      "No saved copy",
      "We have no record of this text on the page. Older highlights land here too — open the page to check.",
      weak
    )
  );
}

function anchorCard(item) {
  const last = item.thread?.messages?.[item.thread.messages.length - 1];
  return `
    <article class="review-card is-orphan" data-id="${item.page.id}">
      <div class="kicker">${escapeHtml(item.page.domain)} · ${escapeHtml(item.label)}</div>
      <q>${escapeHtml(clip(item.highlight?.text || "", 140))}</q>
      ${
        last
          ? `<p class="excerpt"><strong>${last.role === "agent" ? "Agent" : "You"}:</strong> ${escapeHtml(clip(last.content, 120))}</p>`
          : ""
      }
      ${tagRow(item.page)}
      <div class="meta"><span>${escapeHtml(item.page.title)}</span><span>${formatRelative(item.since)}</span></div>
    </article>`;
}

/**
 * Shows the toggle only once there is something to search, and keeps the sort
 * dropdown honest: every one of its options orders pages, which says nothing
 * about which passage answers a query.
 */
function renderSearchMode(passages) {
  if (!els.searchMode) return;
  const available = passagesAvailable();
  els.searchMode.hidden = !available;
  if (!available && state.searchMode === "passages") state.searchMode = "pages";
  const on = state.searchMode === "passages";
  els.searchMode.querySelectorAll("[data-mode]").forEach((btn) => {
    const mine = btn.dataset.mode === state.searchMode;
    btn.classList.toggle("is-on", mine);
    if (btn.dataset.mode === "passages") {
      btn.textContent = available && passages.length ? `Passages (${passages.length})` : "Passages";
    }
  });
  if (els.sort) {
    els.sort.disabled = on;
    els.sort.title = on ? "Passages are ordered by relevance" : "";
  }
}

function passagesHtml(items) {
  if (!items.length) {
    return `<section class="section"><h2>Passages</h2><p class="empty">Nothing you have marked or written mentions that.</p></section>`;
  }
  return `<section class="section"><h2>Passages</h2><p class="hint">The sentence, not the article. Open the page to land on it, or open the record to see it in place.</p><div class="grid">${items
    .map(passageCard)
    .join("")}</div></section>`;
}

const FIELD_LABEL = { highlight: "you marked", user: "you wrote", agent: "an agent replied" };

function passageCard(item) {
  const color = COLORS[item.highlight.color]?.fill || "#F6E27A";
  return `
    <article class="review-card passage-card" data-id="${item.page.id}" data-highlight="${item.highlight.id}" style="--lp-mark:${color}">
      <div class="kicker">${escapeHtml(item.page.domain)} · ${FIELD_LABEL[item.field] || "match"}</div>
      <q>${escapeHtml(clip(item.highlight.text, 160))}</q>
      <p class="excerpt">${snippetHtml(item.snippet)}</p>
      ${tagRow(item.page)}
      <div class="meta">
        <span>${escapeHtml(item.page.title)}</span>
        <button type="button" class="ghost" data-open-live="${item.page.id}" data-live-highlight="${item.highlight.id}">Open page</button>
      </div>
    </article>`;
}

/** Escapes around the match rather than inside it, so the mark stays literal. */
function snippetHtml(snippet) {
  if (!snippet) return "";
  const { text, start, end } = snippet;
  if (end <= start) return escapeHtml(clip(text, 220));
  return `${escapeHtml(text.slice(0, start))}<em>${escapeHtml(text.slice(start, end))}</em>${escapeHtml(
    text.slice(end)
  )}`;
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
        <p class="meta-line">${progressLabel(page)}${page.highlights?.length ? ` · ${page.highlights.length} marks` : ""}${page.inReadingList ? " · reading list" : ""}${page.bookmarked ? " · ★ bookmark" : ""}</p>
        <div class="tweet-actions">
          <a href="${liveUrlFor(page)}" target="_blank" rel="noreferrer" data-live="${page.id}">Open</a>
          <button type="button" data-snooze="${page.id}">Not now</button>
          <button type="button" data-reading="${page.id}">${page.inReadingList ? "In reading list" : "Reading list"}</button>
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
        <button class="ghost" data-reading="${page.id}" title="Reading list">${page.inReadingList ? "Listed" : "List"}</button>
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

function renderRail(pages, bucket) {
  if (!els.rail) return;
  if (!isPortal()) {
    els.rail.hidden = true;
    els.rail.innerHTML = "";
    return;
  }
  els.rail.hidden = false;
  els.rail.innerHTML = [
    statsModule(bucket),
    awaitingModule(bucket.awaiting),
    sourcesModule(pages)
  ].join("");
  els.rail.querySelectorAll("[data-open-id]").forEach((el) => {
    el.onclick = () => openDrawer(el.dataset.openId);
  });
  els.rail.querySelectorAll("[data-goto]").forEach((el) => {
    el.onclick = () => {
      state.filter = el.dataset.goto;
      state.feedPages = 1;
      render();
    };
  });
}

function railModule(title, iconName, color, body) {
  return `
    <section class="mod" style="--room:${color}">
      <h3><span class="mod-ico">${icon(iconName, { size: 15 })}</span>${title}</h3>
      ${body}
    </section>`;
}

function statsModule(bucket) {
  const trail = bucket.trail;
  const cells = [
    { n: bucket.waiting.length, label: "unread", tone: "unread", goto: "home" },
    {
      n: trail.filter((p) => progressOf(p) > 8 && progressOf(p) < 90).length,
      label: "mid-scroll",
      tone: "mid",
      goto: "home"
    },
    { n: trail.filter((p) => !p.openedAt).length, label: "never opened", tone: "new", goto: "saves" },
    { n: bucket.bookmarks.length, label: "bookmarks", tone: "done", goto: "bookmarked" }
  ];
  return railModule(
    "Where you stand",
    "eye",
    ROOMS.home.color,
    `<div class="stat-grid">${cells
      .map(
        (cell) =>
          `<button type="button" class="stat-cell ${cell.tone}" data-goto="${cell.goto}"><strong>${cell.n}</strong><span>${cell.label}</span></button>`
      )
      .join("")}</div>`
  );
}

function awaitingModule(awaiting) {
  if (!awaiting.length) {
    return railModule("Needs a reply", "review", ROOMS.review.color, `<p class="mod-empty">Nothing waiting on you.</p>`);
  }
  return railModule(
    "Needs a reply",
    "review",
    ROOMS.review.color,
    awaiting
      .slice(0, 4)
      .map(
        (item) => `
        <button type="button" class="mod-row" data-open-id="${item.page.id}">
          <span class="mod-row-title">${escapeHtml(clip(item.highlight?.text || item.page.title || "", 64))}</span>
          <span class="mod-row-sub">${escapeHtml(item.page.domain)}</span>
        </button>`
      )
      .join("")
  );
}

function sourcesModule(pages) {
  const tally = new Map();
  for (const page of pages) {
    const key = sourceKey(page);
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
  if (!rows.length) {
    return railModule("Where it came from", "folder", ROOMS.saves.color, `<p class="mod-empty">No sources yet.</p>`);
  }
  const top = rows[0][1];
  return railModule(
    "Where it came from",
    "folder",
    ROOMS.saves.color,
    rows
      .map(([key, n]) => {
        const label = sourceLabel({ importMeta: key === "live" ? null : { source: key } }) || "Browsed";
        const color = sourceColor({ importMeta: key === "live" ? null : { source: key } });
        return `
        <div class="src-row" style="--accent:${color}">
          <span class="src-ico">${sourceIcon(key, { size: 14 })}</span>
          <span class="src-name">${escapeHtml(key === "live" ? "Browsed" : label)}</span>
          <span class="src-bar"><span style="width:${Math.round((n / top) * 100)}%"></span></span>
          <span class="src-n">${n}</span>
        </div>`;
      })
      .join("")
  );
}

function tagRow(page) {
  const tags = displayTags(page, 6);
  if (!tags.length) return "";
  return `<p class="tags">${tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</p>`;
}

function bindView() {
  els.view.querySelectorAll("[data-open], .card, .review-card, .tweet, .row").forEach((el) => {
    el.onclick = (event) => {
      if (el.classList.contains("local-tweet")) return;
      if (event.target.closest("[data-star], [data-reading], [data-snooze], [data-live], a, [data-cta], [data-like], [data-dismiss], [data-open-live]")) return;
      openDrawer(el.dataset.open || el.dataset.id, { focusHighlightId: el.dataset.highlight });
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
  els.view.querySelectorAll("[data-reading]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await call("TOGGLE_READING_LIST", { id: btn.dataset.reading });
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
      if (page?.url) window.open(liveUrlFor(page), "_blank", "noreferrer");
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
  els.view.querySelectorAll("[data-open-live]").forEach((btn) => {
    btn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const page = state.pages.find((p) => p.id === btn.dataset.openLive);
      if (!page?.url) return;
      // The live page re-anchors the highlight and scrolls to it; if the page
      // has since dropped the passage, LivePage says so there.
      const url = liveUrlFor(page, `livepage-highlight=${encodeURIComponent(btn.dataset.liveHighlight)}`);
      window.open(url, "_blank", "noreferrer");
    };
  });
  const more = document.getElementById("feed-more");
  if (more) {
    more.onclick = () => {
      state.feedPages += 1;
      render();
    };
  }
}

async function openDrawer(id, { focusHighlightId } = {}) {
  const page = await call("GET_PAGE", { id });
  if (!page) return;
  state.activeId = id;
  els.drawer.hidden = false;
  document.body.classList.add("drawer-open");
  els.view
    .querySelectorAll(".row")
    .forEach((el) => el.classList.toggle("is-on", el.dataset.id === id));
  const p = progressOf(page);
  const highlights = page.highlights || [];
  const threadsByHighlight = new Map();
  for (const thread of page.threads || []) {
    const list = threadsByHighlight.get(thread.highlightId) || [];
    list.push(thread);
    threadsByHighlight.set(thread.highlightId, list);
  }
  const highlightBlocks = highlights
    .map((highlight) => {
      const color = COLORS[highlight.color]?.fill || "#F6E27A";
      const threads = threadsByHighlight.get(highlight.id) || [];
      return `
        <section class="hl-block" data-highlight="${highlight.id}">
          <q style="border-left: 3px solid ${color}; padding-left: 8px">${escapeHtml(highlight.text || "")}</q>
          <div class="hl-edit">
            ${COLOR_IDS.map(
              (id) =>
                `<button type="button" class="swatch ${highlight.color === id ? "is-on" : ""}" title="${COLORS[id].name} — ${COLORS[id].purpose}" style="--lp-mark:${COLORS[id].fill}" data-hl-color="${id}"></button>`
            ).join("")}
            <button type="button" class="ghost" data-remove-hl="${highlight.id}">Delete highlight</button>
          </div>
          ${threads
            .map((thread) => {
              const last = thread.messages?.[thread.messages.length - 1];
              return `
                <div class="thread">
                  <p>${escapeHtml(thread.branchLabel || "main")}${thread.parentId ? " · forked" : ""}${last?.role === "user" ? " · needs review" : ""}</p>
                  ${(thread.messages || [])
                    .map(
                      (m) =>
                        `<div class="msg-body"><strong>${m.role === "agent" ? `Agent (${m.agent})` : "You"}:</strong> ${renderMessage(m.content)}</div>`
                    )
                    .join("")}
                </div>`;
            })
            .join("")}
        </section>`;
    })
    .join("");

  const source = page.importMeta
    ? `<p class="why">${escapeHtml(page.importMeta.kind || "saved")} from ${escapeHtml(sourceLabel(page))}${page.importMeta.author ? ` · ${escapeHtml(page.importMeta.author)}` : ""}</p>`
    : "";

  els.drawer.innerHTML = `
    <header class="drawer-top">
      <p class="domain">${escapeHtml(sourceLabel(page))} · ${escapeHtml(page.domain)}</p>
      <button type="button" class="act" id="close-drawer" title="Close" aria-label="Close">${icon("close", { size: 15 })}</button>
    </header>
    <h2>${escapeHtml(page.title)}</h2>
    <p class="drawer-open-line"><a class="open-live" href="${liveUrlFor(page)}" target="_blank" rel="noreferrer">Open ${page.kind === "pdf" ? "in the PDF reader" : "live page"} ${icon("external", { size: 13 })}</a></p>
    <div class="progress-hero">
      <div class="bar-row">
        <div class="bar" title="${p}%"><span style="width:${p}%"></span></div>
        <span class="pct">${p}%</span>
      </div>
      <p>${progressLabel(page)} · furthest scroll ${p}% · last on page ${page.openedAt ? formatRelative(page.progress?.updatedAt || page.lastVisitedAt) : "never"}</p>
    </div>
    ${source}
    ${page.why ? `<p class="why">${escapeHtml(page.why)}</p>` : ""}
    <label class="tag-edit">Tags <span class="hint">comma-separated — “machine learning” stays one tag</span>
      <input id="page-tags" value="${escapeHtml((page.tags || []).join(", "))}" placeholder="machine learning, later" />
    </label>
    <p class="tags derived">${displayTags(page)
      .map((tag) => `<span>#${escapeHtml(tag)}</span>`)
      .join("")}</p>
    <div class="actions">
      <button class="ghost" data-act="reading">${page.inReadingList ? "Remove from reading list" : "Add to reading list"}</button>
      <button class="ghost" data-act="bookmark">${page.bookmarked ? "Unbookmark" : "Bookmark"}</button>
      <button class="ghost" data-state="parked">Park</button>
      <button class="ghost" data-state="released">Release</button>
      <button class="ghost" data-act="snooze">Not now</button>
      <button class="solid" data-act="obsidian">${state.vault.bound ? "Write to vault" : "Dump to Obsidian"}</button>
      <button class="ghost" data-act="delete">Remove</button>
    </div>
    <h3>Highlights</h3>
    ${highlightBlocks || "<p class='excerpt'>No highlights yet.</p>"}
  `;
  els.drawer.querySelector("#close-drawer").onclick = () => {
    els.drawer.hidden = true;
    state.activeId = null;
    document.body.classList.remove("drawer-open");
    render();
  };
  const tagInput = els.drawer.querySelector("#page-tags");
  if (focusHighlightId) {
    const block = els.drawer.querySelector(`.hl-block[data-highlight="${cssEscape(focusHighlightId)}"]`);
    if (block) {
      block.classList.add("is-focused");
      block.scrollIntoView({ block: "center" });
    }
  }

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
  els.drawer.querySelector("[data-act='reading']").onclick = async () => {
    await call("TOGGLE_READING_LIST", { id: page.id });
    await reload();
    openDrawer(page.id);
  };
  els.drawer.querySelector("[data-act='snooze']").onclick = async () => {
    await call("SNOOZE_PAGE", { id: page.id, hours: 48 });
    els.drawer.hidden = true;
    state.activeId = null;
    document.body.classList.remove("drawer-open");
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
    state.activeId = null;
    document.body.classList.remove("drawer-open");
    await reload();
  };
  els.drawer.querySelectorAll("[data-hl-color]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const block = btn.closest("[data-highlight]");
      await call("PATCH_HIGHLIGHT", {
        pageId: page.id,
        highlightId: block.dataset.highlight,
        patch: { color: btn.dataset.hlColor }
      });
      await reload();
      openDrawer(page.id);
    };
  });
  els.drawer.querySelectorAll("[data-remove-hl]").forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await call("REMOVE_HIGHLIGHT", { pageId: page.id, highlightId: btn.dataset.removeHl });
      await reload();
      openDrawer(page.id);
    };
  });
}

async function reload() {
  state.pages = (await call("LIST_PAGES")) || [];
  try {
    state.settings = (await call("GET_SETTINGS")) || {};
    applyTheme(state.settings.pageTheme);
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
