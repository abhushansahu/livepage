import { call } from "../shared/bridge.js";
import { applyTheme } from "../shared/theme.js";
import { COLORS, COLOR_IDS } from "../shared/colors.js";
import { EXPERIMENTS, resolveFlags } from "../shared/flags.js";
import { isKept } from "../shared/lists.js";
import { parseTagInput } from "../shared/tags.js";
import { bindVaultFolder, vaultStatus } from "../export/vault.js";

const form = document.getElementById("form");
const status = document.getElementById("status");
const rssList = document.getElementById("rss-list");

if (location.protocol !== "chrome-extension:" && !globalThis.__LP_BRIDGE) {
  const { handleMessage } = await import("../background/handlers.js");
  globalThis.__LP_BRIDGE = (type, payload) => handleMessage({ type, payload });
}

buildSwatches();
buildHours();
buildSegments();
buildLayouts();
watchSections();

let settings = await call("GET_SETTINGS");
applyTheme(settings.pageTheme);
fillForm(settings);
syncWidgets();

form.elements.pageTheme.addEventListener("change", () => {
  applyTheme(form.elements.pageTheme.value);
});

await refreshRss();
await refreshVault();
await refreshHost();
await refreshForget();

document.getElementById("host-ping").onclick = () => refreshHost();

/* ── Autosave ─────────────────────────────────────────────────────────── */

let saveTimer = null;
let toastTimer = null;

form.addEventListener("input", scheduleSave);
form.addEventListener("change", scheduleSave);

function scheduleSave(event) {
  // The feed box is its own action, not a setting.
  if (event?.target?.closest?.("#rss-urls, #rss-tags")) return;
  syncWidgets();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function save() {
  try {
    const patch = currentPatch();
    settings = await call("SAVE_SETTINGS", patch);
    applyTheme(settings.pageTheme);
    if (globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "RESCHEDULE_REMINDER" });
    }
    toast("Saved");
  } catch (error) {
    toast(String(error.message || error), true);
  }
}

function toast(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("is-error", isError);
  status.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { status.hidden = true; }, isError ? 4000 : 1400);
}

/* ── Widgets over hidden fields ───────────────────────────────────────── */

function buildSwatches() {
  const host = document.getElementById("swatches");
  host.innerHTML = COLOR_IDS.map((id) => {
    const c = COLORS[id];
    return `<button type="button" class="swatch" role="radio" aria-checked="false" data-color="${id}" style="--fill:${c.fill}" title="${escapeHtml(c.purpose)}"><i></i>${escapeHtml(c.name)}</button>`;
  }).join("");
  host.querySelectorAll(".swatch").forEach((btn) => {
    btn.onclick = () => {
      form.elements.defaultColor.value = btn.dataset.color;
      form.elements.defaultColor.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
}

function buildHours() {
  const select = form.elements.reminderHour;
  select.innerHTML = Array.from({ length: 24 }, (_, h) => {
    const label = h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`;
    return `<option value="${h}">${label}</option>`;
  }).join("");
}

function buildSegments() {
  document.querySelectorAll(".seg[data-seg]").forEach((seg) => {
    const field = form.elements[seg.dataset.seg];
    seg.querySelectorAll("button").forEach((btn) => {
      btn.setAttribute("role", "radio");
      btn.onclick = () => {
        field.value = btn.dataset.value;
        field.dispatchEvent(new Event("change", { bubbles: true }));
      };
    });
  });
}

function buildLayouts() {
  document.querySelectorAll(".layout").forEach((btn) => {
    btn.onclick = () => {
      form.elements.experimentVariant.value = btn.dataset.variant;
      form.elements.dashboardLayout.value = btn.dataset.layout;
      const flags = EXPERIMENTS["dashboard-density"].variants[btn.dataset.variant]?.flags || {};
      if (typeof flags.forYouFeed === "boolean") form.elements.flagForYou.checked = flags.forYouFeed;
      if (typeof flags.localTweets === "boolean") form.elements.flagLocalTweets.checked = flags.localTweets;
      form.elements.experimentVariant.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
}

/** Reflects hidden field values into the visible controls. */
function syncWidgets() {
  const color = form.elements.defaultColor.value;
  document.querySelectorAll(".swatch").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.color === color));
  });
  const c = COLORS[color] || COLORS.lemon;
  document.getElementById("color-desc").textContent = `${c.name} · ${c.purpose.toLowerCase()}`;
  const preview = document.getElementById("strength-preview");
  preview.style.setProperty("--fill", c.fill);
  preview.style.setProperty("--strength", `${form.elements.highlightStrength.value}%`);

  document.querySelectorAll(".seg[data-seg]").forEach((seg) => {
    const value = form.elements[seg.dataset.seg].value;
    seg.querySelectorAll("button").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.value === value));
    });
  });

  const layout = form.elements.dashboardLayout.value;
  document.querySelectorAll(".layout").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.layout === layout));
  });

  document.getElementById("reminder-hour-field").hidden = !form.elements.remindersEnabled.checked;
}

function watchSections() {
  const links = [...document.querySelectorAll("[data-nav]")];
  const sections = links.map((a) => document.getElementById(a.dataset.nav)).filter(Boolean);
  const mark = (id) => links.forEach((a) => a.classList.toggle("is-on", a.dataset.nav === id));
  mark(sections[0]?.id);
  if (!("IntersectionObserver" in globalThis)) return;
  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity);
    const top = sections
      .filter((s) => seen.get(s.id) !== Infinity && seen.has(s.id))
      .sort((a, b) => Math.abs(seen.get(a.id)) - Math.abs(seen.get(b.id)))[0];
    if (top) mark(top.id);
  }, { rootMargin: "-20% 0px -60% 0px", threshold: [0, 0.2, 1] });
  sections.forEach((s) => io.observe(s));
}

/* ── Actions ──────────────────────────────────────────────────────────── */

async function refreshMirror() {
  const pill = document.getElementById("mirror-pill");
  const note = document.getElementById("mirror-note");
  if (!pill) return;
  const status = await call("MIRROR_STATUS", {}).catch(() => null);
  const host = status?.host;
  const pending = status?.pending ?? 0;
  const live = host ? Object.values(host.stores || {}).reduce((n, s) => n + (s.live || 0), 0) : 0;
  pill.dataset.state = host ? (pending ? "warn" : "ok") : "off";
  pill.textContent = host ? (pending ? `${pending} waiting` : "Up to date") : "Host not running";
  note.textContent = host
    ? `${live} records on the host${host.lastBatchAt ? ` · last write ${relativeAgo(host.lastBatchAt)}` : ""}`
    : pending
      ? `${pending} changes will go over when the host is back.`
      : "";
}

function relativeAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

document.getElementById("mirror-sync").onclick = async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    await call("MIRROR_DRAIN", {});
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync now";
    refreshMirror();
  }
};
refreshMirror();

document.getElementById("forget-browsed").onclick = async () => {
  const note = document.getElementById("forget-status");
  try {
    const result = await call("FORGET_BROWSED", {});
    note.textContent = result.removed
      ? `Forgot ${result.removed} browsed-only ${result.removed === 1 ? "page" : "pages"}. ${result.kept} kept.`
      : "Nothing to forget — every stored page was kept on purpose.";
    document.getElementById("forget-browsed").disabled = true;
  } catch (error) {
    note.textContent = String(error.message || error);
  }
};

async function refreshForget() {
  const note = document.getElementById("forget-status");
  const button = document.getElementById("forget-browsed");
  try {
    const pages = (await call("LIST_PAGES")) || [];
    const stale = pages.filter((page) => !isKept(page)).length;
    button.disabled = !stale;
    note.textContent = stale
      ? `${stale} of ${pages.length} stored pages show no sign you meant to keep them.`
      : `${pages.length} stored pages, all kept on purpose.`;
  } catch {
    note.textContent = "";
  }
}

document.getElementById("rss-add").onclick = async () => {
  const text = document.getElementById("rss-urls").value.trim();
  if (!text) return;
  try {
    const result = await call("ADD_RSS_FEEDS", {
      text,
      tags: parseTagInput(document.getElementById("rss-tags").value)
    });
    settings = result.settings;
    document.getElementById("rss-urls").value = "";
    document.getElementById("rss-tags").value = "";
    await refreshRss();
    const n = result?.feeds?.length || 0;
    toast(n ? `Added ${n} feed${n === 1 ? "" : "s"}` : "No new feeds");
  } catch (error) {
    toast(String(error.message || error), true);
  }
};

document.getElementById("bind-vault").onclick = async () => {
  try {
    const result = await bindVaultFolder();
    if (result.ok) {
      settings = await call("SAVE_SETTINGS", {
        vault: { bound: true, name: result.name, boundAt: result.boundAt }
      });
      toast("Vault bound");
    }
    await refreshVault();
  } catch (error) {
    if (error?.name === "AbortError" || /abort/i.test(String(error.message || error))) return;
    document.getElementById("vault-status").textContent = String(error.message || error);
  }
};

/* ── Patch / fill ─────────────────────────────────────────────────────── */

function currentPatch() {
  return {
    defaultColor: form.elements.defaultColor.value,
    pageTheme: form.elements.pageTheme.value,
    highlightStrength: Number(form.elements.highlightStrength.value || 48),
    agentDefault: form.elements.agentDefault.value,
    cursorModel: form.elements.cursorModel.value,
    claudeCodeModel: form.elements.claudeCodeModel.value,
    agentHostUrl: form.elements.agentHostUrl.value.trim() || "http://127.0.0.1:17321",
    obsidianVault: form.elements.obsidianVault.value.trim(),
    obsidianFolder: form.elements.obsidianFolder.value.trim() || "livepage",
    remindersEnabled: form.elements.remindersEnabled.checked,
    reminderHour: Number(form.elements.reminderHour.value || 9),
    lockInfiniteScroll: form.elements.lockInfiniteScroll.checked,
    importSavesEnabled: form.elements.flagImportSaves.checked,
    localTweetsEnabled: form.elements.flagLocalTweets.checked,
    experiment: { id: "dashboard-density", variant: form.elements.experimentVariant.value, chosen: true },
    flags: {
      forYouFeed: form.elements.flagForYou.checked,
      readingList: form.elements.flagReading.checked,
      bookmarks: form.elements.flagBookmarks.checked,
      saves: form.elements.flagSaves.checked,
      rss: form.elements.flagRss.checked,
      review: form.elements.flagReview.checked,
      localTweets: form.elements.flagLocalTweets.checked,
      importSaves: form.elements.flagImportSaves.checked,
      articleSymbols: form.elements.flagArticleSymbols.checked,
      orphanRecovery: form.elements.flagOrphanRecovery.checked,
      markup: form.elements.flagMarkup.checked,
      minimap: form.elements.flagMinimap.checked,
      dashboardLayout: form.elements.dashboardLayout.value
    }
  };
}

function fillForm(value) {
  const { flags, experiment } = resolveFlags(value);
  form.elements.defaultColor.value = value.defaultColor || "lemon";
  form.elements.pageTheme.value = value.pageTheme || "coffee";
  form.elements.highlightStrength.value = value.highlightStrength ?? 48;
  form.elements.agentDefault.value = value.agentDefault || "cursor";
  form.elements.cursorModel.value = value.cursorModel || "composer-2.5";
  form.elements.claudeCodeModel.value = value.claudeCodeModel || "sonnet";
  form.elements.agentHostUrl.value = value.agentHostUrl || "http://127.0.0.1:17321";
  form.elements.obsidianVault.value = value.obsidianVault || "";
  form.elements.obsidianFolder.value = value.obsidianFolder || "livepage";
  form.elements.remindersEnabled.checked = value.remindersEnabled !== false;
  form.elements.reminderHour.value = value.reminderHour ?? 9;
  form.elements.lockInfiniteScroll.checked = value.lockInfiniteScroll !== false;
  form.elements.experimentVariant.value = experiment.variant;
  form.elements.dashboardLayout.value = flags.dashboardLayout;
  form.elements.flagForYou.checked = flags.forYouFeed !== false;
  form.elements.flagReading.checked = flags.readingList !== false;
  form.elements.flagBookmarks.checked = flags.bookmarks !== false;
  form.elements.flagSaves.checked = flags.saves !== false;
  form.elements.flagRss.checked = flags.rss !== false;
  form.elements.flagReview.checked = flags.review !== false;
  form.elements.flagLocalTweets.checked = Boolean(flags.localTweets);
  form.elements.flagImportSaves.checked = flags.importSaves !== false;
  form.elements.flagArticleSymbols.checked = Boolean(flags.articleSymbols);
  form.elements.flagOrphanRecovery.checked = flags.orphanRecovery !== false;
  form.elements.flagMarkup.checked = flags.markup !== false;
  form.elements.flagMinimap.checked = flags.minimap !== false;
}

/* ── Refreshers ───────────────────────────────────────────────────────── */

async function refreshRss() {
  settings = await call("GET_SETTINGS");
  const feeds = settings.rssFeeds || [];
  if (!feeds.length) {
    rssList.innerHTML = `<li class="empty">No feeds yet. Add one below, or from a page that advertises RSS.</li>`;
    return;
  }
  rssList.innerHTML = feeds
    .map(
      (feed) => `<li>
        <div class="feed-main">
          <strong>${escapeHtml(feed.title || feed.url)}</strong>
          <span class="feed-meta">${escapeHtml(hostOf(feed.url))}${(feed.tags || []).length ? " · " : ""}<span class="feed-tag">${(feed.tags || []).map((tag) => `#${escapeHtml(tag)}`).join(" ")}</span></span>
        </div>
        <button type="button" class="btn" data-remove="${escapeHtml(feed.id)}">Remove</button>
      </li>`
    )
    .join("");
  rssList.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.onclick = async () => {
      settings = await call("REMOVE_RSS_FEED", { id: btn.dataset.remove });
      await refreshRss();
      toast("Feed removed");
    };
  });
}

async function refreshVault() {
  const el = document.getElementById("vault-status");
  const pill = document.getElementById("vault-pill");
  const button = document.getElementById("bind-vault");
  try {
    const info = await vaultStatus();
    if (info.bound) {
      pill.dataset.state = "ok";
      pill.textContent = info.name;
      el.textContent = "Write from the dashboard, then git commit and push. The other machine pulls the same vault.";
      button.textContent = "Rebind folder";
    } else {
      pill.dataset.state = "off";
      pill.textContent = "Not bound";
      el.textContent = "Pick the cloned vault folder, the git repo root.";
      button.textContent = "Bind folder";
    }
  } catch {
    pill.dataset.state = "off";
    pill.textContent = "Unavailable";
    el.textContent = "Folder bind is unavailable in this context. Markdown download still works.";
    button.disabled = true;
  }
}

async function refreshHost() {
  const el = document.getElementById("host-status");
  const pill = document.getElementById("host-pill");
  pill.dataset.state = "checking";
  pill.textContent = "Checking…";
  try {
    const result = await call("PING_AGENT_HOST");
    if (result?.ok && result.auth !== false) {
      pill.dataset.state = "ok";
      pill.textContent = "Reachable";
      el.textContent = `Cursor CLI: ${result.cursorOk ? result.cursor : "not found"} · Claude Code: ${result.claudeOk ? result.claude : "not found"}`;
    } else if (result?.ok) {
      pill.dataset.state = "bad";
      pill.textContent = "Not paired";
      el.textContent = "Restart npm run agent-host, then check again.";
    } else {
      throw new Error("down");
    }
  } catch {
    pill.dataset.state = "bad";
    pill.textContent = "Unreachable";
    el.textContent = "In the LivePage repo: npm run agent-host";
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
