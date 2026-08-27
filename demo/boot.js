import { handleMessage } from "../extension/background/handlers.js";

if (!globalThis.chrome?.runtime?.id) {
  globalThis.__LP_BRIDGE = async (type, payload) => handleMessage({ type, payload });
  globalThis.__LP_ON_BROADCAST = (handler) => () => {};
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("../extension/content/content.css", import.meta.url).href;
  document.documentElement.appendChild(css);
  await import("../extension/content/content.js");
}
