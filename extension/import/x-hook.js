(() => {
  if (globalThis.__LP_X_HOOK) return;
  globalThis.__LP_X_HOOK = true;
  globalThis.__LP_X_BOOKMARKS = [];

  function capture(url, body) {
    const href = String(url || "");
    if (!/graphql/i.test(href) || !/bookmark/i.test(href)) return;
    try {
      const json = typeof body === "string" ? JSON.parse(body) : body;
      if (json && typeof json === "object") globalThis.__LP_X_BOOKMARKS.push(json);
    } catch {
      /* ignore non-json */
    }
  }

  const origFetch = globalThis.fetch;
  if (typeof origFetch === "function") {
    globalThis.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const req = args[0];
        const url = typeof req === "string" ? req : req?.url || "";
        res
          .clone()
          .text()
          .then((text) => capture(url, text))
          .catch(() => {});
      } catch {
        /* ignore */
      }
      return res;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__lpUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      capture(this.__lpUrl, this.responseText);
    });
    return origSend.apply(this, args);
  };
})();
