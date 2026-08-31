export const SOURCES = [
  {
    id: "twitter",
    name: "X",
    label: "X bookmarks",
    kind: "bookmark",
    hosts: ["x.com", "twitter.com"],
    libraryPaths: ["/i/bookmarks"],
    libraryUrl: "https://x.com/i/bookmarks"
  },
  {
    id: "reddit",
    name: "Reddit",
    label: "Reddit saved",
    kind: "saved",
    hosts: ["reddit.com", "old.reddit.com", "new.reddit.com"],
    libraryPaths: ["/saved"],
    libraryUrl: "https://www.reddit.com/saved"
  },
  {
    id: "youtube",
    name: "YouTube",
    label: "YouTube Watch Later",
    kind: "watch_later",
    hosts: ["youtube.com", "m.youtube.com", "music.youtube.com"],
    libraryPaths: ["/playlist"],
    libraryUrl: "https://www.youtube.com/playlist?list=WL"
  },
  {
    id: "pocket",
    name: "Pocket",
    label: "Pocket saves",
    kind: "saved",
    hosts: ["getpocket.com"],
    libraryPaths: ["/saves", "/my-list", "/readitlater"],
    libraryUrl: "https://getpocket.com/saves"
  },
  {
    id: "hn",
    name: "HN",
    label: "HN favorites",
    kind: "favorite",
    hosts: ["news.ycombinator.com"],
    libraryPaths: ["/favorites"],
    libraryUrl: "https://news.ycombinator.com/favorites"
  }
];

export const REFRESH_SOURCE_IDS = ["twitter", "reddit", "youtube"];

export function sourceById(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

export function isRefreshSource(id) {
  return REFRESH_SOURCE_IDS.includes(id);
}

export function hostnameOfUrl(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function classifyLibraryUrl(raw) {
  const host = hostnameOfUrl(raw);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  for (const source of SOURCES) {
    if (!source.hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    if (source.id === "youtube") {
      const list = url.searchParams.get("list") || "";
      if (list.toUpperCase() === "WL") return source;
      continue;
    }
    if (source.id === "reddit") {
      if (path === "/saved" || /\/user\/[^/]+\/saved$/i.test(path)) return source;
      continue;
    }
    if (source.libraryPaths.some((p) => path === p || path.startsWith(`${p}/`))) return source;
  }
  return null;
}

export function sourceForHost(raw) {
  const host = hostnameOfUrl(raw);
  return (
    SOURCES.find((source) => source.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null
  );
}

export function isLibraryUrl(raw) {
  return Boolean(classifyLibraryUrl(raw));
}
