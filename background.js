// Background service worker to proxy fetches (Met API) to avoid page CORS

const EXT = chrome || browser;

EXT.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "bgFetch" || !message.url) return;
  const { url, options } = message;
  (async () => {
    try {
      const resp = await fetch(url, options || {});
      const contentType = resp.headers.get("content-type") || "";
      if (!resp.ok) {
        sendResponse({ ok: false, status: resp.status, statusText: resp.statusText });
        return;
      }
      if (contentType.includes("application/json")) {
        const data = await resp.json();
        sendResponse({ ok: true, json: data });
      } else {
        const text = await resp.text();
        sendResponse({ ok: true, text });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || "fetch_failed" });
    }
  })();
  return true; // keep the message channel open
});

