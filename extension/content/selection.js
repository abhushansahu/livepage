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
