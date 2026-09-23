import { handleMessage } from "../extension/background/handlers.js";

if (!globalThis.chrome?.runtime?.id) {
  globalThis.__LP_BRIDGE = async (type, payload) => handleMessage({ type, payload });
  // Outside the extension there is no service worker to drain the mirror, so
  // a queued write drains itself a moment later.
  const { onMirrorEnqueued } = await import("../extension/storage/store.js");
  let mirrorTimer = 0;
  onMirrorEnqueued(() => {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => globalThis.__LP_BRIDGE("MIRROR_DRAIN", {}).catch(() => {}), 1500);
  });

  globalThis.__LP_ON_BROADCAST = (handler) => () => {};
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("../extension/content/content.css", import.meta.url).href;
  document.documentElement.appendChild(css);
  await import("../extension/content/content.js");
}
