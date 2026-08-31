/** Reading list, Bookmarks, and Saves are three different memberships. */

export const SAVE_SOURCES = ["twitter", "reddit", "youtube"];

export function isSave(page) {
  const source = page?.importMeta?.source;
  return Boolean(source && SAVE_SOURCES.includes(source));
}

export function isRss(page) {
  return page?.importMeta?.source === "rss";
}

export function isReadingList(page) {
  return Boolean(page?.inReadingList) && page.readState !== "released";
}

export function isBookmark(page) {
  return Boolean(page?.bookmarked);
}

export function listMembership(page) {
  return {
    readingList: isReadingList(page),
    bookmark: isBookmark(page),
    save: isSave(page),
    rss: isRss(page)
  };
}
