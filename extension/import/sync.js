import { getSettings, listPages } from "../storage/store.js";
import { fetchRedditSaved, fetchYoutubeWatchLater } from "./fetchers.js";
import { isRefreshSource } from "./sources.js";
import { uniqueItems } from "./normalize.js";
import { resolveFlags } from "../shared/flags.js";
import { prepareTwitterBookmarksPage, scrapeTwitterBookmarksFromPage, scrapeCapturedTwitterBookmarksFromPage } from "./twitter.js";

const TWITTER_BOOKMARKS_URL = "https://x.com/i/bookmarks";
const TWITTER_TAB_PATTERNS = [
  "*://x.com/i/bookmarks*",
  "*://twitter.com/i/bookmarks*",
  "*://x.com/*/bookmarks*",
  "*://twitter.com/*/bookmarks*"
];

export async function syncSaves({ openTabs = false, importItems } = {}) {
  const settings = await getSettings();
  const { flags } = resolveFlags(settings);
  if (!flags.importSaves) {
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

  const twitter = await harvestTwitterBookmarks({ openTab: openTabs });
  reports.push(summarize(twitter));
  collected.push(...(twitter.items || []));

  const items = uniqueItems(collected).filter((item) => isRefreshSource(item.importMeta?.source));
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
    if (!source || !isRefreshSource(source)) continue;
    bySource[source] = (bySource[source] || 0) + 1;
  }
  return { counts: bySource, total: pages.filter((p) => isRefreshSource(p.importMeta?.source)).length };
}

async function harvestTwitterBookmarks({ openTab = false } = {}) {
  if (typeof chrome === "undefined" || !chrome.tabs?.query || !chrome.scripting?.executeScript) {
    return { source: "twitter", ok: false, status: "no-tabs", items: [] };
  }
  const previous = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const previousId = previous[0]?.id || 0;
  let tabId = await findTwitterBookmarksTab();
  let opened = false;
  if (!tabId && openTab && chrome.tabs.create) {
    const tab = await chrome.tabs.create({ url: TWITTER_BOOKMARKS_URL, active: true });
    tabId = tab?.id || 0;
    opened = Boolean(tabId);
  }
  if (!tabId) {
    return { source: "twitter", ok: false, status: "no-tab", items: [] };
  }
  const stopHook = watchAndInjectXHook(tabId);
  try {
    try {
      await chrome.tabs.update(tabId, { active: true, autoDiscardable: false });
    } catch {
      /* tab may already be gone */
    }
    if (!opened) {
      try {
        await chrome.tabs.reload(tabId);
      } catch {
        /* already navigating */
      }
    }
    const ready = await waitForTwitterReady(tabId);
    if (!ready.ok && ready.status === "login") {
      await restoreTab(previousId, tabId);
      return { source: "twitter", ok: false, status: "login", items: [] };
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: prepareTwitterBookmarksPage
      });
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "ISOLATED",
          func: prepareTwitterBookmarksPage
        });
      } catch {
        /* still spinning */
      }
    }
    let items = await readCapturedBookmarks(tabId);
    if (!items.length) {
      for (let i = 0; i < 8; i += 1) {
        items = await scrapeTwitterTab(tabId);
        if (items.length) break;
        const again = await readCapturedBookmarks(tabId);
        if (again.length) {
          items = again;
          break;
        }
        await delay(600);
      }
    }
    await restoreTab(previousId, tabId);
    if (opened && items.length && chrome.tabs.remove) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* user may have closed it */
      }
    }
    return {
      source: "twitter",
      ok: items.length > 0,
      status: items.length ? "ok" : "empty",
      items
    };
  } finally {
    stopHook();
  }
}

async function readCapturedBookmarks(tabId) {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: scrapeCapturedTwitterBookmarksFromPage
    });
    return uniqueItems((injected || []).flatMap((frame) => frame?.result || []));
  } catch {
    return [];
  }
}

function watchAndInjectXHook(tabId) {
  if (!chrome.tabs?.onUpdated || !chrome.scripting?.executeScript) return () => {};
  const inject = () => {
    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        injectImmediately: true,
        files: ["import/x-hook.js"]
      })
      .catch(() => {});
  };
  inject();
  const onUpdated = (id, info) => {
    if (id !== tabId) return;
    if (info.status === "loading" || info.status === "complete") inject();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => {
    try {
      chrome.tabs.onUpdated.removeListener(onUpdated);
    } catch {
      /* listener already gone */
    }
  };
}

async function scrapeTwitterTab(tabId) {
  const worlds = ["MAIN", "ISOLATED"];
  const collected = [];
  for (const world of worlds) {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world,
        func: scrapeTwitterBookmarksFromPage
      });
      for (const frame of injected || []) {
        collected.push(...(frame?.result || []));
      }
      if (collected.length) break;
    } catch {
      /* world or frame refused */
    }
  }
  return uniqueItems(collected);
}

async function findTwitterBookmarksTab() {
  const tabs = await chrome.tabs.query({ url: TWITTER_TAB_PATTERNS });
  const hit = tabs.find((tab) => tab.id && /bookmarks/i.test(tab.url || tab.pendingUrl || ""));
  return hit?.id || 0;
}

async function waitForTwitterReady(tabId, timeoutMs = 28000) {
  const start = Date.now();
  let lastUrl = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      lastUrl = tab?.url || tab?.pendingUrl || "";
      if (/\/i\/flow\/login|\/login/i.test(lastUrl)) {
        return { ok: false, status: "login" };
      }
      if (isBookmarksUrl(lastUrl) && tab.status === "complete") {
        const captured = await countCapturedBookmarks(tabId);
        if (captured > 0) return { ok: true, status: "graphql" };
        const count = await countTwitterNodes(tabId);
        if (count > 0) return { ok: true, status: "ok" };
      }
    } catch {
      /* tab still loading */
    }
    await delay(400);
  }
  if (/\/i\/flow\/login|\/login/i.test(lastUrl)) return { ok: false, status: "login" };
  if (isBookmarksUrl(lastUrl)) return { ok: true, status: "timeout-continue" };
  return { ok: false, status: lastUrl ? `wrong-url` : "not-ready" };
}

async function countCapturedBookmarks(tabId) {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => (globalThis.__LP_X_BOOKMARKS || []).length
    });
    return (injected || []).reduce((sum, frame) => sum + (frame?.result || 0), 0);
  } catch {
    return 0;
  }
}

async function countTwitterNodes(tabId) {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () =>
        document.querySelectorAll(
          'article[data-testid="tweet"], div[data-testid="cellInnerDiv"] a[href*="/status/"], a[href*="/status/"]'
        ).length
    });
    return (injected || []).reduce((sum, frame) => sum + (frame?.result || 0), 0);
  } catch {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "ISOLATED",
        func: () => document.querySelectorAll('article, a[href*="/status/"]').length
      });
      return (injected || []).reduce((sum, frame) => sum + (frame?.result || 0), 0);
    } catch {
      return 0;
    }
  }
}

function isBookmarksUrl(url) {
  return /(?:x\.com|twitter\.com)\/(?:i\/)?(?:[^/]+\/)?bookmarks/i.test(url || "");
}

async function restoreTab(previousId, harvestId) {
  if (!previousId || previousId === harvestId || !chrome.tabs?.update) return;
  try {
    await chrome.tabs.update(previousId, { active: true });
  } catch {
    /* original tab closed */
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(report) {
  return {
    source: report.source,
    ok: report.ok,
    status: report.status,
    items: report.items?.length || 0
  };
}
