/**
 * One theme choice, made in settings, worn by every surface: the margin notes on
 * a live page, the dashboard, the popup, and this settings page itself.
 */

export const THEMES = [
  { id: "coffee", label: "Coffee (light)" },
  { id: "dark", label: "Dark" }
];

export function normalizeTheme(value) {
  return value === "dark" ? "dark" : "coffee";
}

export function applyTheme(value, root = document.documentElement) {
  const theme = normalizeTheme(value);
  if (!root) return theme;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
  return theme;
}

export function watchTheme(onChange) {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return () => {};
  const listener = (message) => {
    if (message?.broadcast && message.kind === "SETTINGS_CHANGED" && message.settings) {
      onChange(message.settings);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
