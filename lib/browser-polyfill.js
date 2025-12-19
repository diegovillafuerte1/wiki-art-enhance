// Lightweight bridge to align Chrome's chrome.* API with Firefox-style browser.* namespace.
// This is a minimal shim; for full coverage use the official webextension-polyfill.
(function () {
  if (typeof self !== "undefined" && self.browser) return;
  const chromeAPI = typeof self !== "undefined" ? self.chrome : undefined;
  if (!chromeAPI) return;

  const wrap = (target) =>
    new Proxy(target, {
      get(obj, prop) {
        if (prop === "then") return undefined; // allow await on real promises only
        const value = obj[prop];
        if (typeof value === "function") {
          return (...args) => {
            try {
              return value.apply(obj, args);
            } catch (e) {
              return Promise.reject(e);
            }
          };
        }
        if (value && typeof value === "object") return wrap(value);
        return value;
      }
    });

  self.browser = wrap(chromeAPI);
})();

