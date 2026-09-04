/**
 * Pages often collapse the live Selection on mouseup (to show their own
 * menu). Keep the last range from this gesture so the toolbar can stay.
 */
export function toolbarAction({ liveHasRange, gestureSelected, savedRange }) {
  if (liveHasRange) return "show";
  if (gestureSelected && savedRange && !savedRange.collapsed) return "show";
  return "hide";
}

export function rangeRect(range) {
  if (!range || range.collapsed) return null;
  try {
    const box = range.getBoundingClientRect();
    if (box.width || box.height) return box;
    const next = [...range.getClientRects()].find((r) => r.width || r.height);
    return next || null;
  } catch {
    return null;
  }
}

/**
 * Which of our own shortcuts a keypress is, if any.
 *
 * Read from `code`, the physical key, never from `key`. On macOS Option is
 * the Alt key and composes a character with it — Option+S is "ß", Option+J is
 * "∆" — so matching on `key` means the shortcut silently never fires there.
 */
const SHORTCUTS = { KeyS: "symbols", KeyJ: "next-mark", KeyK: "prev-mark" };

export function shortcutAction(event, { typing = false } = {}) {
  if (!event?.altKey || event.ctrlKey || event.metaKey) return null;
  // Held keys must not repeat a toggle.
  if (event.repeat) return null;
  // Option is a character key on a Mac; while you are writing, it is yours.
  if (typing) return null;
  return SHORTCUTS[event.code] || null;
}

/** Whether the keystroke belongs to something being written into. */
export function isTypingTarget(event, ownsEvent) {
  if (ownsEvent?.(event)) return true;
  const el = event?.target;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest("input, textarea, select, [contenteditable]"));
}
