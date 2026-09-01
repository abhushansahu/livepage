(() => {
  if (globalThis.__LP_X_HOOK) return;
  globalThis.__LP_X_HOOK = true;
  globalThis.__LP_X_BOOKMARKS = [];

  function wants(url) {
    const href = String(url || "");
    return /graphql/i.test(href) && /bookmark/i.test(href);
  }

  function capture(url, body) {
    if (!wants(url)) return;
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
        if (wants(url)) {
          res
            .clone()
            .text()
            .then((text) => capture(url, text))
            .catch(() => {});
        }
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
      if (!wants(this.__lpUrl)) return;
      // responseText throws unless responseType is "" or "text", and x.com asks
      // for arraybuffer on media, so never touch it blind.
      const type = this.responseType;
      try {
        if (type === "json") capture(this.__lpUrl, this.response);
        else if (!type || type === "text") capture(this.__lpUrl, this.responseText);
      } catch {
        /* unreadable body */
      }
    });
    return origSend.apply(this, args);
  };
})();
