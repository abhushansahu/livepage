import { getSettings, listPages } from "../storage/store.js";
import { fetchRedditSaved, fetchYoutubeWatchLater, LIBRARY_TABS } from "./fetchers.js";
import { sourceForHost } from "./sources.js";
import { uniqueItems } from "./normalize.js";

export async function syncSaves({ openTabs = false, importItems } = {}) {
  const settings = await getSettings();
  if (settings.importSavesEnabled === false) {
    return { ok: false, reason: "disabled", reports: [], imported: 0 };
  }
  const reports = [];
  const collected = [];

  const reddit = await fetchRedditSaved();
  reports.push(summarize(reddit));
  collected.push(...(reddit.items || []));

  const youtube = await fetchYoutubeWatchLater();
  reports.push(summarize(youtube));
  collected.push(...(youtube.items || []));

  const fromTabs = await harvestOpenSiteTabs();
  reports.push(...fromTabs.reports);
  collected.push(...fromTabs.items);

  if (openTabs && typeof chrome !== "undefined" && chrome.tabs?.create) {
    const opened = await nudgeLibraryTabs();
    reports.push({ source: "tabs", ok: true, status: `opened ${opened}`, items: 0 });
  }

  const items = uniqueItems(collected);
  let imported = 0;
  if (items.length && importItems) {
    const result = await importItems(items);
    imported = result?.imported || items.length;
  }
  return { ok: true, reports, imported, itemCount: items.length, items };
}

export async function buildSyncPreview() {
  const pages = await listPages();
  const bySource = {};
  for (const page of pages) {
    const source = page.importMeta?.source;
    if (!source) continue;
    bySource[source] = (bySource[source] || 0) + 1;
  }
  return { counts: bySource, total: pages.filter((p) => p.importMeta).length };
}

async function harvestOpenSiteTabs() {
  const reports = [];
  const items = [];
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    return { reports, items };
  }
  const tabs = await chrome.tabs.query({
    url: [
      "*://x.com/*",
      "*://twitter.com/*",
      "*://www.reddit.com/*",
      "*://old.reddit.com/*",
      "*://www.youtube.com/*",
      "*://m.youtube.com/*",
      "*://getpocket.com/*",
      "*://news.ycombinator.com/*"
    ]
  });
  for (const tab of tabs) {
    if (!tab.id) continue;
    const source = sourceForHost(tab.url);
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        broadcast: true,
        kind: "HARVEST_SAVES"
      });
      const harvested = response?.data?.items || response?.items || [];
      items.push(...harvested);
      reports.push({
        source: source?.id || "tab",
        ok: true,
        status: `tab ${harvested.length}`,
        items: harvested.length
      });
    } catch {
      reports.push({ source: source?.id || "tab", ok: false, status: "no-content-script", items: 0 });
    }
  }
  return { reports, items };
}

async function nudgeLibraryTabs() {
  if (!chrome.tabs?.query) return 0;
  let opened = 0;
  for (const lib of LIBRARY_TABS) {
    const existing = await chrome.tabs.query({ url: `${new URL(lib.url).origin}/*` });
    const already = existing.find((t) => (t.url || "").includes(new URL(lib.url).pathname));
    if (already) continue;
    await chrome.tabs.create({ url: lib.url, active: false });
    opened += 1;
  }
  return opened;
}

function summarize(report) {
  return {
    source: report.source,
    ok: report.ok,
    status: report.status,
    items: report.items?.length || 0
  };
}
