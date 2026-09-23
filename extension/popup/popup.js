import { call } from "../shared/bridge.js";
import { applyTheme } from "../shared/theme.js";
import { formatRelative } from "../shared/time.js";
import { parseTagInput, suggestedTagsForHost } from "../shared/tags.js";
import { hostnameOf } from "../shared/url.js";
import { resolveFlags } from "../shared/flags.js";
import { mutedHere, toggleSiteSurface } from "../shared/site-prefs.js";
import { looksLikePdfUrl } from "../pdf/route.js";
import { icon, sourceIcon } from "../shared/icons.js";
import { sourceKey } from "../shared/source-meta.js";
import { deriveReadState, progressOf } from "../shared/progress.js";

// Outside the extension — the demo server, a screenshot — there is no active
// tab to ask about. A `?tab=` in the URL stands in for one, and the handlers
// answer directly, the way the dashboard's shim does.
const inExtension = Boolean(globalThis.chrome?.tabs?.query);
if (!inExtension && !globalThis.__LP_BRIDGE) {
  const { handleMessage } = await import("../background/handlers.js");
  globalThis.__LP_BRIDGE = (type, payload) => handleMessage({ type, payload });
}

const els = {
  list: document.getElementById("list"),
  title: document.getElementById("title"),
  domain: document.getElementById("domain"),
  state: document.getElementById("state"),
  glyph: document.getElementById("glyph"),
  bar: document.getElementById("bar"),
  reading: document.getElementById("reading"),
  star: document.getElementById("star"),
  letgo: document.getElementById("letgo"),
  tagChips: document.getElementById("tag-chips"),
  tags: document.getElementById("tags"),
  status: document.getElementById("status"),
  switches: document.getElementById("switches"),
  siteNote: document.getElementById("site-note"),
  gist: document.getElementById("gist"),
  gistWhen: document.getElementById("gist-when"),
  gistText: document.getElementById("gist-text"),
  gistMore: document.getElementById("gist-more"),
  waitingCount: document.getElementById("waiting-count")
};

document.getElementById("dashboard").innerHTML = icon("home", { size: 16 });
document.getElementById("options").innerHTML = icon("settings", { size: 16 });
els.reading.querySelector(".ico").innerHTML = icon("reading", { size: 14 });
els.star.querySelector(".ico").innerHTML = icon("star", { size: 14 });
els.letgo.querySelector(".ico").innerHTML = icon("letgo", { size: 14 });
els.gist.querySelector(".spark").innerHTML = icon("spark", { size: 11 });

document.getElementById("dashboard").onclick = () => openHome();
document.getElementById("waiting-more").onclick = () => openHome();
document.getElementById("options").onclick = () => {
  if (globalThis.chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open("../options/options.html", "_blank");
};

function openHome() {
  if (globalThis.chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    window.close();
  } else {
    window.open("../dashboard/index.html", "_blank");
  }
}

let settings = {};
try {
  settings = (await call("GET_SETTINGS")) || {};
  applyTheme(settings.pageTheme);
} catch {
  /* first run, before any settings exist */
}

const tab = await activeTab();
const tabUrl = tab?.url || "";
const tabTitle = tab?.title || tabUrl;
const host = hostnameOf(tabUrl);
const isWeb = /^https?:/i.test(tabUrl);
els.title.textContent = tabTitle || "This page";
els.domain.textContent = host || (tabUrl ? tabUrl.split(":")[0] : "");

let page = null;
if (isWeb) {
  try {
    page = await call("GET_PAGE", { url: tabUrl });
  } catch {
    page = null;
  }
}
renderPage();
renderSwitches();
renderGist();
renderWaiting();

async function activeTab() {
  if (inExtension) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t;
  }
  const params = new URLSearchParams(location.search);
  const url = params.get("tab") || "";
  return url ? { url, title: params.get("title") || url } : null;
}

// ── This page ──────────────────────────────────────────────────────────

els.reading.onclick = async () => {
  if (!isWeb) {
    flash("This page cannot be queued.");
    return;
  }
  try {
    page = await call("TOGGLE_READING_LIST", {
      url: tabUrl,
      title: tabTitle,
      tags: currentTags(),
      on: page ? !page.inReadingList : true
    });
    renderPage();
    flash(page.inReadingList ? "On the reading list." : "Off the reading list.");
  } catch (error) {
    flash(String(error.message || error));
  }
};

els.star.onclick = async () => {
  if (!isWeb) return;
  try {
    if (!page?.id) page = await ensurePage();
    page = await call("TOGGLE_BOOKMARK", { id: page.id });
    renderPage();
    flash(page.bookmarked ? "Starred." : "Star removed.");
  } catch (error) {
    flash(String(error.message || error));
  }
};

// Letting go is not deleting: the page stays kept and findable, it just
// stops being something you owe. Bring it back from the same chip.
els.letgo.onclick = async () => {
  if (!page?.id) return;
  const released = page.readState === "released";
  try {
    page = await call("SET_READ_STATE", {
      id: page.id,
      readState: released ? deriveReadState(page.progress?.maxPercent || 0) : "released"
    });
    renderPage();
    renderWaiting();
    flash(released ? "Back on the list." : "Let go. It stays findable.");
  } catch (error) {
    flash(String(error.message || error));
  }
};

async function ensurePage() {
  return call("ENSURE_PAGE", { url: tabUrl, title: tabTitle, tags: currentTags() });
}

function currentTags() {
  return page?.tags || [];
}

els.tags.addEventListener("keydown", async (event) => {
  if (event.key === "Escape") {
    els.tags.value = "";
    els.tags.blur();
    return;
  }
  if (event.key === "Backspace" && !els.tags.value && page?.tags?.length) {
    await saveTags(page.tags.slice(0, -1));
    return;
  }
  if (event.key !== "Enter" && event.key !== ",") return;
  event.preventDefault();
  await commitTagInput();
});
els.tags.addEventListener("blur", () => commitTagInput());

async function commitTagInput() {
  const added = parseTagInput(els.tags.value);
  els.tags.value = "";
  if (!added.length || !isWeb) return;
  const merged = [...new Set([...(page?.tags || []), ...added])];
  await saveTags(merged);
}

async function saveTags(tags) {
  try {
    if (!page?.id) page = await ensurePage();
    page = await call("SET_TAGS", { id: page.id, tags });
    renderPage();
  } catch (error) {
    flash(String(error.message || error));
  }
}

function renderPage() {
  const listed = Boolean(page?.inReadingList);
  const starred = Boolean(page?.bookmarked);
  const released = page?.readState === "released";
  els.glyph.innerHTML = sourceIcon(page ? sourceKey(page) : "live", { size: 16 });
  els.reading.classList.toggle("is-on", listed);
  els.reading.querySelector(".txt").textContent = listed ? "On the list" : "Reading list";
  els.star.classList.toggle("is-on", starred);
  els.star.querySelector(".txt").textContent = starred ? "Starred" : "Star";
  els.letgo.hidden = !page?.id;
  els.letgo.querySelector(".txt").textContent = released ? "Bring back" : "Let go";
  els.letgo.classList.toggle("is-on", released);

  // One state word. Kept pages say how far you got; a fresh page says nothing.
  const pr = page ? progressOf(page) : 0;
  els.state.className = "";
  if (!page) els.state.textContent = isWeb ? "" : "Not a web page";
  else if (released) {
    els.state.textContent = "Let go";
    els.state.classList.add("is-released");
  } else if (pr >= 90) {
    els.state.textContent = "Read through";
    els.state.classList.add("is-ok");
  } else if (pr > 8) els.state.textContent = `Read ${Math.round(pr)}%`;
  else els.state.textContent = page.lastVisitedAt ? "Kept" : "Not opened";
  els.bar.hidden = !(page && pr > 8 && pr < 90);
  els.bar.querySelector("i").style.width = `${Math.round(pr)}%`;

  const tags = page?.tags || [];
  els.tagChips.innerHTML = tags
    .map((t) => `<button type="button" class="tag-chip" data-tag="${escapeHtml(t)}" title="Remove">#${escapeHtml(t)}</button>`)
    .join("");
  els.tagChips.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.onclick = () => saveTags(tags.filter((t) => t !== btn.dataset.tag));
  });
  const suggested = suggestedTagsForHost(host);
  els.tags.placeholder = tags.length ? "+ tag" : suggested.length ? `+ ${suggested[0]}` : "+ tag";
  els.tags.disabled = !isWeb;
}

// ── The gist ──────────────────────────────────────────────────────────

async function renderGist() {
  els.gist.hidden = true;
  if (!page?.id) return;
  let markup = null;
  try {
    markup = await call("LATEST_MARKUP", { pageId: page.id });
  } catch {
    markup = null;
  }
  if (!markup?.gist) return;
  els.gistText.textContent = markup.gist;
  els.gistWhen.textContent = markup.at ? `· ${formatRelative(markup.at)}` : "";
  const n = (markup.marks || []).length;
  els.gistMore.textContent = n ? `${n} passage${n === 1 ? "" : "s"} worth stopping at. ⌥J and ⌥K move between them.` : "";
  els.gist.hidden = false;
}

// ── On this page ──────────────────────────────────────────────────────

/**
 * What is on for this page, and the key that changes it. The shortcuts are
 * the fast path; this is the one you reach for when you cannot remember them,
 * so every row names its own key rather than hiding it in Settings.
 */
function renderSwitches() {
  const { flags } = resolveFlags(settings);
  const markupOn = flags.markup !== false && !mutedHere(settings, tabUrl, "markup");
  const rows = [];

  if (looksLikePdfUrl(tabUrl)) {
    rows.push({ id: "pdf", action: true, key: "", label: "Open this PDF in LivePage", sub: "Highlights and margin threads, in the document", glyph: "external" });
  }
  rows.push(
    siteRow("markup", flags.markup !== false, { key: "⌥A", label: "Mark what is worth stopping at" }),
    siteRow("symbols", Boolean(flags.articleSymbols), { key: "⌥S", label: "Explain unfamiliar terms" })
  );
  if (isWeb && markupOn) {
    rows.push({ id: "rerun", action: true, key: "⌥⇧A", label: "Read this page again", sub: "Drops the marks on file and asks for a fresh pass", glyph: "refresh" });
  }
  rows.push(siteRow("minimap", flags.minimap !== false, { key: "", label: "Article shape down the edge" }));

  els.switches.innerHTML = rows
    .map(
      (row) => `
      <button type="button" class="switch${row.action ? " is-action" : ""}${row.on ? " on" : ""}" data-switch="${row.id}" role="${row.action ? "button" : "switch"}" ${row.action ? "" : `aria-checked="${row.on ? "true" : "false"}"`}>
        <span class="label">${escapeHtml(row.label)}${row.sub ? `<span class="sub">${escapeHtml(row.sub)}</span>` : ""}</span>
        <span class="key">${row.key}</span>
        ${row.action ? `<span class="glyph">${icon(row.glyph, { size: 13 })}</span>` : `<span class="toggle"></span>`}
      </button>`
    )
    .join("");
  els.switches.querySelectorAll("[data-switch]").forEach((btn) => {
    btn.onclick = () => onSwitch(btn.dataset.switch);
  });
  els.siteNote.textContent = isWeb ? "These rows are for this site. Settings turns one off everywhere." : "LivePage works on http and https pages.";
}

function siteRow(id, globallyOn, { key, label }) {
  const offHere = mutedHere(settings, tabUrl, id);
  return {
    id,
    on: globallyOn && !offHere,
    key,
    label,
    sub: !globallyOn ? "Off everywhere · turn it back on here" : !host ? "" : offHere ? `Off for ${host}` : `On for ${host}`
  };
}

const GLOBAL_FLAG = { symbols: "articleSymbols", markup: "markup", minimap: "minimap" };

async function onSwitch(id) {
  const { flags } = resolveFlags(settings);
  if (id === "pdf") {
    await call("OPEN_PDF", { url: tabUrl }).catch(() => {});
    window.close();
    return;
  }
  if (id === "rerun") {
    await rerunMarkup();
    return;
  }
  const flag = GLOBAL_FLAG[id];
  if (!flag) return;
  const globallyOn = id === "symbols" ? Boolean(flags.articleSymbols) : flags[flag] !== false;
  try {
    if (!globallyOn) {
      settings = await call("SAVE_SETTINGS", { flags: { ...(settings.flags || {}), [flag]: true } });
      flash("On again, everywhere it was not already muted.");
    } else {
      const next = toggleSiteSurface(settings, tabUrl, id);
      if (!next.host) {
        settings = await call("SAVE_SETTINGS", { flags: { ...(settings.flags || {}), [flag]: false } });
        flash("Off everywhere.");
      } else {
        settings = await call("SAVE_SETTINGS", next.patch);
        flash(next.muted ? `Off for ${next.host}.` : `On for ${next.host}.`);
      }
    }
    renderSwitches();
  } catch (error) {
    flash(String(error.message || error));
  }
}

async function rerunMarkup() {
  if (!tab?.id || !globalThis.chrome?.tabs?.sendMessage) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { broadcast: true, kind: "RERUN_MARKUP" });
    window.close();
  } catch {
    flash("LivePage is not running on this page. Reload it and try again.");
  }
}

// ── Waiting ───────────────────────────────────────────────────────────

async function renderWaiting() {
  let unread = [];
  try {
    unread = (await call("UNREAD_PAGES")) || [];
  } catch {
    unread = [];
  }
  els.waitingCount.textContent = unread.length ? String(unread.length) : "";
  if (!unread.length) {
    els.list.innerHTML = `<p class="empty">Nothing waiting. Star a page, or add it to the reading list, when you mean to come back.</p>`;
    return;
  }
  els.list.innerHTML = unread
    .slice(0, 5)
    .map((item) => {
      const pr = Math.round(item.progress?.maxPercent || 0);
      const when = item.lastVisitedAt ? formatRelative(item.lastVisitedAt) : "never opened";
      return `<button type="button" class="item" data-url="${escapeHtml(item.url)}">
        <span class="glyph">${sourceIcon(sourceKey(item), { size: 13 })}</span>
        <span><span class="t">${escapeHtml(item.title || item.url)}</span><span class="m">${escapeHtml(item.domain)} · ${pr > 8 ? `<b>${pr}%</b> · ` : ""}${escapeHtml(when)}</span></span>
      </button>`;
    })
    .join("");
  els.list.querySelectorAll(".item").forEach((btn) => {
    btn.onclick = () => {
      if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url: btn.dataset.url });
      else window.open(btn.dataset.url, "_blank");
    };
  });
}

// ── Toast ─────────────────────────────────────────────────────────────

let toastTimer = 0;
function flash(text) {
  els.status.hidden = false;
  els.status.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.status.hidden = true;
  }, 2600);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
