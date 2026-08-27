export async function call(type, payload = {}) {
  if (typeof globalThis.__LP_BRIDGE === "function") {
    return globalThis.__LP_BRIDGE(type, payload);
  }
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (response && response.ok === false) {
    throw new Error(response.error || "LivePage request failed");
  }
  return response?.data;
}

export function onBroadcast(handler) {
  if (typeof globalThis.__LP_ON_BROADCAST === "function") {
    return globalThis.__LP_ON_BROADCAST(handler);
  }
  const listener = (message) => {
    if (message?.broadcast) handler(message);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
