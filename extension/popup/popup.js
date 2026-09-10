import { call } from "../shared/bridge.js";
import { applyTheme } from "../shared/theme.js";
import { formatRelative } from "../shared/time.js";
import { parseTagInput, suggestedTagsForHost } from "../shared/tags.js";
import { hostnameOf } from "../shared/url.js";
import { resolveFlags } from "../shared/flags.js";
import { mutedHere, toggleSiteSurface } from "../shared/site-prefs.js";
import { looksLikePdfUrl } from "../pdf/route.js";

const list = document.getElementById("list");
const titleEl = document.getElementById("title");
const domainEl = document.getElementById("domain");
const readingBtn = document.getElementById("reading");
const starBtn = document.getElementById("star");
const tagsInput = document.getElementById("tags");
const status = document.getElementById("status");
const switches = document.getElementById("switches");
const siteNote = document.getElementById("site-note");

document.getElementById("dashboard").onclick = () => {
  chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  window.close();
};

document.getElementById("options").onclick = () => {
  chrome.runtime.openOptionsPage();
};

let settings = {};
try {
  settings = (await call("GET_SETTINGS")) || {};
  applyTheme(settings.pageTheme);
} catch {
  /* first run, before any settings exist */
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabUrl = tab?.url || "";
const tabTitle = tab?.title || tabUrl;
const host = hostnameOf(tabUrl);
titleEl.textContent = tabTitle || "This page";
domainEl.textContent = host;

let page = null;
if (/^https?:/i.test(tabUrl)) {
  try {
    page = await call("GET_PAGE", { url: tabUrl });
  } catch {
    page = null;
  }
}
renderPage();
renderSwitches();

readingBtn.onclick = async () => {
  if (!/^https?:/i.test(tabUrl)) {
    flash("This page cannot be queued.");
    return;
  }
  try {
    page = await call("TOGGLE_READING_LIST", {
      url: tabUrl,
      title: tabTitle,
      tags: parseTagInput(tagsInput.value),
      on: page ? !page.inReadingList : true
    });
    renderPage();
    flash(page.inReadingList ? "On the reading list." : "Removed from reading list.");
  } catch (error) {
    flash(String(error.message || error));
  }
};

starBtn.onclick = async () => {
  if (!/^https?:/i.test(tabUrl)) return;
  try {
    if (!page?.id) {
      page = await call("ENSURE_PAGE", {
        url: tabUrl,
        title: tabTitle,
        tags: parseTagInput(tagsInput.value)
      });
    }
    page = await call("TOGGLE_BOOKMARK", { id: page.id });
    renderPage();
    flash(page.bookmarked ? "Bookmarked." : "Bookmark removed.");
  } catch (error) {
    flash(String(error.message || error));
  }
};

let tagTimer = 0;
tagsInput.addEventListener("change", saveTags);
tagsInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  saveTags();
});
tagsInput.addEventListener("input", () => {
  clearTimeout(tagTimer);
  tagTimer = setTimeout(saveTags, 700);
});

async function saveTags() {
  const tags = parseTagInput(tagsInput.value);
  if (!page?.id || !/^https?:/i.test(tabUrl)) return;
  try {
    page = await call("SET_TAGS", { id: page.id, tags });
  } catch {
    /* page may not exist yet */
  }
}

function renderPage() {
  const listed = Boolean(page?.inReadingList);
  const starred = Boolean(page?.bookmarked);
  readingBtn.textContent = listed ? "Remove from reading list" : "Add to reading list";
  readingBtn.classList.toggle("on", listed);
  starBtn.textContent = starred ? "★ Bookmarked" : "☆ Bookmark";
  starBtn.classList.toggle("on", starred);
  if (document.activeElement !== tagsInput) {
    const existing = page?.tags || [];
    const suggested = suggestedTagsForHost(host);
    tagsInput.value = existing.length ? existing.join(", ") : "";
    tagsInput.placeholder = suggested.length
      ? `${suggested[0]}, later`
      : "machine learning, later";
  }
}

/**
 * What is on for this page, and the key that changes it.
 *
 * The shortcuts are the fast path; this is the one you reach for when you
 * cannot remember them, so every row names its own key rather than hiding it
 * in Settings.
 */
function renderSwitches() {
  if (!switches) return;
  const { flags } = resolveFlags(settings);
  const article = /^https?:/i.test(tabUrl);
  const markupOn = flags.markup !== false && !mutedHere(settings, tabUrl, "markup");

  const rows = [];

  // Only when this tab is a document we can actually open. Offering it
  // everywhere would make the row furniture, and it stops being a signal.
  if (looksLikePdfUrl(tabUrl)) {
    rows.push({
      id: "pdf",
      on: true,
      key: "",
      label: "Open this PDF in LivePage",
      sub: "Highlights and margin conversations, in the document"
    });
  }

  rows.push(
    siteRow("markup", flags.markup !== false, {
      key: "⌥A",
      label: "Mark the passages worth stopping at"
    }),
    siteRow("symbols", Boolean(flags.articleSymbols), {
      key: "⌥S",
      label: "Explain unfamiliar terms"
    })
  );

  // Only where there is something to ask again about. A page LivePage cannot
  // read, or one you have muted, has nothing to re-read.
  if (article && markupOn) {
    rows.push({
      id: "rerun",
      action: true,
      key: "⌥⇧A",
      label: "Read this page again",
      sub: "Drops the marks on file and asks for a fresh pass"
    });
  }

  rows.push(
    siteRow("minimap", flags.minimap !== false, {
      key: "",
      label: "Show marked passages down the edge"
    })
  );

  switches.innerHTML = rows
    .map(
      (row) => `
      <button type="button" class="switch${row.action ? " is-action" : ""}${row.on ? " on" : ""}" data-switch="${row.id}">
        <span class="${row.action ? "glyph" : "dot"}">${row.action ? "↻" : ""}</span>
        <span class="label">${escapeHtml(row.label)}${row.sub ? `<span class="sub">${escapeHtml(row.sub)}</span>` : ""}</span>
        <span class="key">${row.key}</span>
      </button>`
    )
    .join("");

  switches.querySelectorAll("[data-switch]").forEach((btn) => {
    btn.onclick = () => onSwitch(btn.dataset.switch);
  });

  siteNote.textContent = article
    ? "⌥J and ⌥K move between marked passages. These rows are for this site; Settings turns one off everywhere."
    : "LivePage only works on http and https pages.";
}

/**
 * One row for a surface that can be off here and on everywhere else.
 *
 * "Off everywhere" and "off for this site" are different answers and want
 * different switches, so the row says which one it is rather than leaving a
 * reader to wonder why the same toggle did something else last time.
 */
function siteRow(id, globallyOn, { key, label }) {
  const offHere = mutedHere(settings, tabUrl, id);
  return {
    id,
    on: globallyOn && !offHere,
    key,
    label,
    sub: !globallyOn
      ? "Off everywhere · turn it back on here"
      : !host
        ? ""
        : offHere
          ? `Off for ${host}`
          : `On for ${host}`
  };
}

/** The global flag standing behind each per-site row. */
const GLOBAL_FLAG = { symbols: "articleSymbols", markup: "markup", minimap: "minimap" };

/**
 * A row means "here" — unless the surface is off everywhere, in which case
 * there is nothing for a site to have an opinion about and the row turns it
 * back on for good.
 */
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
      // Whatever this site said before is left where it was: turning a surface
      // back on everywhere should not quietly forget the one page you muted.
      settings = await call("SAVE_SETTINGS", {
        flags: { ...(settings.flags || {}), [flag]: true }
      });
      flash("On again, everywhere it was not already muted.");
    } else {
      const next = toggleSiteSurface(settings, tabUrl, id);
      // Nowhere to pin a preference on a page with no host, so the row stays
      // the global switch it used to be.
      if (!next.host) {
        settings = await call("SAVE_SETTINGS", {
          flags: { ...(settings.flags || {}), [flag]: false }
        });
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

/**
 * Asks the page in front of you to read itself again.
 *
 * Sent to the tab rather than run from here, because a pass needs the article
 * as rendered and the popup has a URL and nothing else.
 */
async function rerunMarkup() {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { broadcast: true, kind: "RERUN_MARKUP" });
    window.close();
  } catch {
    flash("LivePage is not running on this page. Reload it and try again.");
  }
}

function flash(text) {
  status.hidden = false;
  status.textContent = text;
}

const unread = (await call("UNREAD_PAGES")) || [];
if (!unread.length) {
  list.innerHTML = `<p class="empty">Nothing waiting. Queue a page onto the reading list when you mean to come back.</p>`;
} else {
  list.innerHTML = unread
    .slice(0, 6)
    .map(
      (item) =>
        `<button class="item" data-url="${item.url}"><strong>${escapeHtml(item.title)}</strong><br/><small>${escapeHtml(item.domain)} · ${item.progress?.maxPercent || 0}% · ${formatRelative(item.lastVisitedAt)}</small></button>`
    )
    .join("");
  list.querySelectorAll(".item").forEach((btn) => {
    btn.onclick = () => {
      chrome.tabs.create({ url: btn.dataset.url });
    };
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
