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

/**
 * Did the user deliberately keep this page, or did they just open it?
 *
 * LivePage stores a record only for pages that answer yes. Opening hundreds of
 * tabs a day is not a signal, and counting them would poison every number we
 * derive — "never opened" and "% read through" only mean something measured
 * against pages you meant to come back to.
 */
export function isKept(page) {
  if (!page) return false;
  return Boolean(
    page.highlights?.length ||
      page.threads?.length ||
      page.bookmarked ||
      page.inReadingList ||
      page.importMeta ||
      page.tags?.length ||
      page.why ||
      page.snapshot ||
      page.readState === "parked"
  );
}

export function listMembership(page) {
  return {
    readingList: isReadingList(page),
    bookmark: isBookmark(page),
    save: isSave(page),
    rss: isRss(page)
  };
}
