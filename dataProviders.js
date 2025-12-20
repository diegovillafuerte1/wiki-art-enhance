// Shared data providers for art sources (Met Museum, Europeana)
// Exposes window.WACProviders with fetch helpers used by gallery/content scripts

const WAC_EXT = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null;
const PROVIDER_DEBUG = true;
const PROVIDER_YEAR_PADDING = 20;
const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_DEFAULT_LIMIT = 20;

const metCache = new Map(); // key -> { ts, data, promise }
const europeanaCache = new Map(); // key -> { ts, data, promise }

const ENV_EUROPEANA_API_KEY =
  typeof EUROPEANA_API_KEY !== "undefined"
    ? EUROPEANA_API_KEY
    : typeof process !== "undefined" && process.env
      ? process.env.EUROPEANA_API_KEY
      : null;

function bgJson(url) {
  return new Promise((resolve, reject) => {
    if (!WAC_EXT?.runtime?.sendMessage) {
      fetch(url)
        .then((resp) => {
          if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
          return resp.json();
        })
        .then(resolve)
        .catch(reject);
      return;
    }
    try {
      WAC_EXT.runtime.sendMessage({ type: "bgFetch", url }, (resp) => {
        if (resp?.ok && resp.json) {
          resolve(resp.json);
        } else {
          reject(new Error(resp?.error || `bgFetch failed: ${resp?.status || "unknown"}`));
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

let europeanaApiKeyPromise = null;

function makeCacheKey({ location, year, limit }) {
  return `${location || ""}|${year || ""}|${limit || ""}`;
}

function normalizeLocation(raw) {
  if (!raw) return "";
  const first = raw.split(",")[0].trim();
  return first.replace(/\s+/g, " ");
}

function isLikelyPlace(text) {
  if (!text) return false;
  if (/\d/.test(text)) return false;
  return text.split(/\s+/).length <= 5;
}

function mapMetItem(obj) {
  if (!obj || !obj.primaryImageSmall) return null;
  const location = obj.repository || obj.GalleryNumber || obj.department || "";
  return {
    id: `met-${obj.objectID || obj.id}`,
    title: obj.title,
    artist: obj.artistDisplayName,
    date: obj.objectDate,
    thumb: obj.primaryImageSmall,
    full: obj.primaryImage,
    source: "Met Museum",
    location
  };
}

function mapEuropeanaItem(item) {
  if (!item) return null;
  const thumb = Array.isArray(item.edmPreview) ? item.edmPreview[0] : null;
  if (!thumb) return null;
  const full = Array.isArray(item.edmIsShownBy) && item.edmIsShownBy[0] ? item.edmIsShownBy[0] : thumb;
  const title =
    (Array.isArray(item.title) && item.title[0]) ||
    (Array.isArray(item.dataProvider) && item.dataProvider[0]) ||
    "Untitled";
  const artist =
    (Array.isArray(item.dcCreator) && item.dcCreator[0]) ||
    (Array.isArray(item.dataProvider) && item.dataProvider[0]) ||
    "";
  const date =
    (Array.isArray(item.year) && item.year[0]) ||
    (Array.isArray(item.edmTimespanLabel) && item.edmTimespanLabel[0]) ||
    "";
  const location =
    (Array.isArray(item.dataProvider) && item.dataProvider[0]) ||
    (Array.isArray(item.provider) && item.provider[0]) ||
    (Array.isArray(item.country) && item.country[0]) ||
    "";
  return {
    id: `eu-${item.id || item.guid || thumb}`,
    title,
    artist,
    date,
    thumb,
    full,
    source: "Europeana",
    location
  };
}

function getStoredEuropeanaKey() {
  if (!WAC_EXT || !WAC_EXT.storage || !WAC_EXT.storage.local) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      WAC_EXT.storage.local.get(["europeanaApiKey"], (res) => {
        resolve(res?.europeanaApiKey || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function getEuropeanaApiKey() {
  if (ENV_EUROPEANA_API_KEY) return ENV_EUROPEANA_API_KEY;
  if (!europeanaApiKeyPromise) {
    europeanaApiKeyPromise = getStoredEuropeanaKey();
  }
  return europeanaApiKeyPromise;
}

async function fetchMetArtworks({ location, year, limit = PROVIDER_DEFAULT_LIMIT }) {
  const key = makeCacheKey({ location, year, limit });
  const now = Date.now();
  const cached = metCache.get(key);
  if (cached?.data && cached.ts + PROVIDER_CACHE_TTL_MS > now) {
    return cached.data;
  }
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const dateBegin = year ? year - PROVIDER_YEAR_PADDING : 0;
    const dateEnd = year ? year + PROVIDER_YEAR_PADDING : 2100;
    const query = encodeURIComponent(location || "");
    const searchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${query}&dateBegin=${dateBegin}&dateEnd=${dateEnd}`;
    const searchData = await bgJson(searchUrl);
    if (!searchData || !searchData.objectIDs) throw new Error("Met search failed");
    const ids = (searchData.objectIDs || []).slice(0, limit);
    const results = [];
    for (const id of ids) {
      try {
        const obj = await bgJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
        const mapped = mapMetItem(obj);
        if (mapped) results.push(mapped);
      } catch (_) {
        // ignore individual fetch errors
      }
    }
    return results;
  })();

  metCache.set(key, { promise });
  try {
    const data = await promise;
    metCache.set(key, { ts: Date.now(), data });
    return data;
  } catch (err) {
    metCache.delete(key);
    throw err;
  }
}

async function fetchEuropeanaArtworks({ location, year, limit = PROVIDER_DEFAULT_LIMIT }) {
  const apiKey = await getEuropeanaApiKey();
  if (!apiKey) {
    if (PROVIDER_DEBUG) console.warn("[WAC][EU] Missing Europeana API key");
    return [];
  }
  if (year == null) {
    throw new Error("Europeana search requires a year");
  }

  const key = makeCacheKey({ location, year, limit });
  const now = Date.now();
  const cached = europeanaCache.get(key);
  if (cached?.data && cached.ts + PROVIDER_CACHE_TTL_MS > now) {
    return cached.data;
  }
  if (cached?.promise) return cached.promise;

  const promise = (async () => {
    const cleanLocation = normalizeLocation(location);
    const yearQuery = year != null
      ? `YEAR:[${Math.max(0, year - PROVIDER_YEAR_PADDING)} TO ${year + PROVIDER_YEAR_PADDING}]`
      : null;
    if (!yearQuery) throw new Error("Europeana search requires a year");
    const baseQuery = yearQuery;

    const buildUrl = ({ useSpatial, useYearFilters }) => {
      const url = new URL("https://api.europeana.eu/record/v2/search.json");
      url.searchParams.set("wskey", apiKey);
      url.searchParams.set("query", baseQuery);
      url.searchParams.set("media", "true");
      url.searchParams.set("profile", "rich");
      url.searchParams.set("rows", String(limit));
      url.searchParams.append("qf", "TYPE:IMAGE");
      if (useSpatial && cleanLocation && isLikelyPlace(cleanLocation)) {
        url.searchParams.append("qf", `spatial:${cleanLocation}`);
      }
      if (useYearFilters && yearQuery) {
        url.searchParams.append("qf", yearQuery);
      }
      return url.toString();
    };

    const attempts = [
      { useSpatial: true, useYearFilters: true, label: "spatial+year" },
      { useSpatial: false, useYearFilters: true, label: "no-spatial+year" },
      { useSpatial: false, useYearFilters: false, label: "query-only" }
    ];

    for (const attempt of attempts) {
      const finalUrl = buildUrl(attempt);
      if (PROVIDER_DEBUG) console.info("[WAC][EU] fetch", attempt.label, finalUrl);
      let data = null;
      try {
        data = await bgJson(finalUrl);
      } catch (err) {
        if (PROVIDER_DEBUG) console.warn("[WAC][EU] fetch error", attempt.label, err);
        continue;
      }
      const results = (data.items || [])
        .map(mapEuropeanaItem)
        .filter(Boolean);
      if (PROVIDER_DEBUG) console.info("[WAC][EU] results", attempt.label, results.length);
      if (results.length > 0) return results;
    }
    return [];
  })();

  europeanaCache.set(key, { promise });
  try {
    const data = await promise;
    europeanaCache.set(key, { ts: Date.now(), data });
    return data;
  } catch (err) {
    europeanaCache.delete(key);
    throw err;
  }
}

async function fetchRelatedArtworks({ location, year, limitPerProvider = PROVIDER_DEFAULT_LIMIT }) {
  const [metRes, euRes] = await Promise.allSettled([
    fetchMetArtworks({ location, year, limit: limitPerProvider }),
    fetchEuropeanaArtworks({ location, year, limit: limitPerProvider })
  ]);

  const results = [];
  if (metRes.status === "fulfilled" && Array.isArray(metRes.value)) {
    results.push(...metRes.value);
  }
  if (euRes.status === "fulfilled" && Array.isArray(euRes.value)) {
    results.push(...euRes.value);
  }
  return results;
}

// Expose on window for both contentScript and gallery usage
window.WACProviders = Object.assign({}, window.WACProviders, {
  fetchMetArtworks,
  fetchEuropeanaArtworks,
  fetchRelatedArtworks,
  getEuropeanaApiKey
});

