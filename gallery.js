const YEAR_PADDING = 20;
const MAX_RESULTS = 30;
const BATCH_SIZE = 12;
const CACHE_TTL_MS = 5 * 60 * 1000;

let state = {
  items: [],
  visible: 0,
  requestId: 0
};

const metCache = new Map(); // key -> { ts, data, promise }

function debounce(fn, wait = 300) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

const debouncedLoad = debounce(load, 200);

function getParams() {
  const url = new URL(window.location.href);
  return {
    location: url.searchParams.get("location") || "",
    year: url.searchParams.get("year") ? parseInt(url.searchParams.get("year"), 10) : null
  };
}

async function fetchMetArtworks({ location, year }) {
  const key = `${location || ""}|${year || ""}`;
  const now = Date.now();
  const cached = metCache.get(key);
  if (cached && cached.data && cached.ts + CACHE_TTL_MS > now) {
    return cached.data;
  }
  if (cached && cached.promise) {
    return cached.promise;
  }

  const promise = (async () => {
    const dateBegin = year ? year - YEAR_PADDING : 0;
    const dateEnd = year ? year + YEAR_PADDING : 2100;
    const query = encodeURIComponent(location || "");
    const searchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${query}&dateBegin=${dateBegin}&dateEnd=${dateEnd}`;
    const searchResp = await fetch(searchUrl);
    if (!searchResp.ok) throw new Error("Met search failed");
    const searchData = await searchResp.json();
    const ids = (searchData.objectIDs || []).slice(0, MAX_RESULTS);
    const results = [];
    for (const id of ids) {
      try {
        const objResp = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
        if (!objResp.ok) continue;
        const obj = await objResp.json();
        if (!obj.primaryImageSmall) continue;
        results.push({
          id,
          title: obj.title,
          artist: obj.artistDisplayName,
          date: obj.objectDate,
          thumb: obj.primaryImageSmall
        });
      } catch (e) {
        // ignore individual fetch errors
      }
    }
    metCache.set(key, { ts: Date.now(), data: results });
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

function renderStatus(text) {
  document.getElementById("status").textContent = text;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  if (!state.items.length) {
    renderStatus("No related art found.");
    return;
  }
  renderStatus("");
  const slice = state.items.slice(0, state.visible);
  for (const item of slice) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <img src="${item.thumb}" alt="${item.title}" loading="lazy" />
      <div class="meta">
        <div class="title">${item.title || "Untitled"}</div>
        <div class="subtitle">${[item.artist, item.date].filter(Boolean).join(" • ")}</div>
      </div>
    `;
    grid.appendChild(card);
  }
  updateLoadMore();
}

async function load({ location, year }) {
  const requestId = ++state.requestId;
  renderStatus("Loading...");
  state.items = [];
  state.visible = 0;
  try {
    const items = await fetchMetArtworks({ location, year });
    if (requestId !== state.requestId) return; // stale response
    state.items = items;
    state.visible = Math.min(BATCH_SIZE, items.length);
    renderGrid();
  } catch (e) {
    if (requestId !== state.requestId) return;
    renderStatus("Failed to load art data.");
  }
}

function updateLoadMore() {
  const btn = document.getElementById("loadMoreBtn");
  if (!btn) return;
  const hasMore = state.visible < state.items.length;
  btn.disabled = !hasMore;
  btn.style.display = state.items.length ? "inline-block" : "none";
}

function setupLoadMore() {
  const btn = document.getElementById("loadMoreBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const nextVisible = Math.min(state.visible + BATCH_SIZE, state.items.length);
    state.visible = nextVisible;
    renderGrid();
  });
}

function setupControls() {
  const { location, year } = getParams();
  const locInput = document.getElementById("locationInput");
  const yearInput = document.getElementById("yearInput");
  if (location) locInput.value = location;
  if (year) yearInput.value = year;

  const triggerLoad = () => {
    const nextLocation = locInput.value.trim();
    const nextYear = yearInput.value ? parseInt(yearInput.value, 10) : null;
    debouncedLoad({ location: nextLocation, year: nextYear });
  };

  document.getElementById("refreshBtn").addEventListener("click", triggerLoad);
}

document.addEventListener("DOMContentLoaded", () => {
  setupControls();
  setupLoadMore();
  const params = getParams();
  debouncedLoad(params);
});

