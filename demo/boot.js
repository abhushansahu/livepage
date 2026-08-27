import { handleMessage } from "../extension/background/handlers.js";

if (!globalThis.chrome?.runtime?.id) {
  globalThis.__LP_BRIDGE = async (type, payload) => handleMessage({ type, payload });
  globalThis.__LP_ON_BROADCAST = (handler) => () => {};
  await import("../extension/content/content.js");
}
