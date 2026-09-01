/**
 * Inline stroke icons. Everything draws in currentColor so a parent can tint an
 * icon by setting `color`, which is how the portal nav and rows get their hue.
 */

const STROKE = {
  home: '<path d="M3 10.6 12 3l9 7.6V20a1 1 0 0 1-1 1h-4.5v-6h-7v6H4a1 1 0 0 1-1-1z"/>',
  reading:
    '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 1 5.5 18H20v3H5.5A1.5 1.5 0 0 1 4 19.5z"/>',
  star: '<path d="m12 3.6 2.65 5.37 5.93.86-4.29 4.18 1.01 5.9L12 17.13l-5.3 2.79 1.01-5.9-4.29-4.18 5.93-.86z"/>',
  saves: '<path d="M6 3h12v18l-6-4.3L6 21z"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5.5" cy="18.5" r="1.6"/>',
  review: '<path d="M4 5h16v11h-9.5L5 20.5V16H4z"/><path d="M8 9h8M8 12.5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  tag: '<path d="M3.5 11.4V4.5a1 1 0 0 1 1-1h6.9L21 13.1 13.1 21z"/><circle cx="7.8" cy="7.8" r="1.2"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5V9H15"/>',
  folder: '<path d="M3 6.5h6L11 9h10v11.5H3z"/>',
  download: '<path d="M12 3v11.5"/><path d="m8 11 4 4 4-4"/><path d="M4 20.5h16"/>',
  settings:
    '<path d="M3.5 7.5h17M3.5 16.5h17"/><circle cx="9" cy="7.5" r="2.4"/><circle cx="15" cy="16.5" r="2.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.3l3.4 2"/>',
  eye: '<path d="M2.5 12S6.3 6 12 6s9.5 6 9.5 6-3.8 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.6"/>',
  spark: '<path d="m12 3 1.9 5.4L19.5 10l-5.6 1.6L12 17l-1.9-5.4L4.5 10l5.6-1.6z"/>',
  comment: '<path d="M4 5h16v11H9l-5 4v-4z"/><path d="M8 9h8M8 12h5"/>',
  branch: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="9" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 9h6"/>',
  at: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 15.5V9h-3a3 3 0 1 0 3 3c0 2.2 1 3.5 2.7 3.5 1.6 0 2.8-1.4 2.8-3.5"/>',
  close: '<path d="m5.5 5.5 13 13M18.5 5.5l-13 13"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14.5v5H4.5V6h5"/>'
};

const SOURCE = {
  twitter: '<path d="m4.5 4.5 15 15M19.5 4.5l-15 15"/>',
  reddit:
    '<ellipse cx="12" cy="14" rx="8" ry="5.6"/><path d="M16 6.5 14.6 12"/><circle cx="16.6" cy="6" r="1.4"/><path d="M9.4 13.4h.01M14.6 13.4h.01"/><path d="M9.6 16.6a4.6 4.6 0 0 0 4.8 0"/>',
  youtube: '<rect x="2.8" y="6" width="18.4" height="12" rx="3.4"/><path d="m10.3 9.8 5 2.2-5 2.2z"/>',
  pocket: '<path d="M3.5 4.5h17v6.6a8.5 8.5 0 0 1-17 0z"/><path d="m8.3 10.2 3.7 3.6 3.7-3.6"/>',
  hn: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="m8.6 8 3.4 4.4L15.4 8"/><path d="M12 12.4V16"/>',
  rss: STROKE.rss,
  live: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 15.5h4"/>'
};

function svg(body, size, className) {
  return `<svg class="ico${className ? ` ${className}` : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function icon(name, { size = 18, className = "" } = {}) {
  const body = STROKE[name];
  if (!body) return "";
  return svg(body, size, className);
}

export function sourceIcon(key, { size = 16, className = "" } = {}) {
  return svg(SOURCE[key] || SOURCE.live, size, className);
}

export const ROOM_ICONS = {
  home: "spark",
  reading: "reading",
  bookmarked: "star",
  saves: "saves",
  rss: "rss",
  review: "review"
};
