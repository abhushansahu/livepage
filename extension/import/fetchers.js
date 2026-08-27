import { itemsFromRedditListing } from "./reddit.js";
import { itemsFromYoutubeHtml } from "./youtube.js";
import { sourceById } from "./sources.js";

export async function fetchRedditSaved(fetchImpl = fetch) {
  try {
    const res = await fetchImpl("https://www.reddit.com/saved.json?limit=100&raw_json=1", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return { source: "reddit", ok: false, status: res.status, items: [] };
    const json = await res.json();
    if (json?.error || !json?.data) {
      return { source: "reddit", ok: false, status: json?.error || "empty", items: [] };
    }
    return {
      source: "reddit",
      ok: true,
      items: itemsFromRedditListing(json, sourceById("reddit").libraryUrl)
    };
  } catch (error) {
    return { source: "reddit", ok: false, status: String(error.message || error), items: [] };
  }
}

export async function fetchYoutubeWatchLater(fetchImpl = fetch) {
  try {
    const res = await fetchImpl("https://www.youtube.com/playlist?list=WL", {
      credentials: "include",
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { source: "youtube", ok: false, status: res.status, items: [] };
    const html = await res.text();
    if (/accounts\.google\.com|ServiceLogin/i.test(html) && !html.includes("ytInitialData")) {
      return { source: "youtube", ok: false, status: "not-signed-in", items: [] };
    }
    const items = itemsFromYoutubeHtml(html, sourceById("youtube").libraryUrl);
    return { source: "youtube", ok: items.length > 0, items, status: items.length ? "ok" : "empty" };
  } catch (error) {
    return { source: "youtube", ok: false, status: String(error.message || error), items: [] };
  }
}

export const LIBRARY_TABS = [
  { source: "twitter", url: "https://x.com/i/bookmarks" },
  { source: "reddit", url: "https://www.reddit.com/saved" },
  { source: "youtube", url: "https://www.youtube.com/playlist?list=WL" }
];
