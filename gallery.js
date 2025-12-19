const MAX_RESULTS = 30;
const BATCH_SIZE = 12;

let state = {
  items: [],
  visible: 0,
  requestId: 0
};

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

function fetchArtworks({ location, year }) {
  const providers = window.WACProviders || {};
  if (providers.fetchRelatedArtworks) {
    return providers.fetchRelatedArtworks({ location, year, limitPerProvider: MAX_RESULTS });
  }
  if (providers.fetchMetArtworks) {
    return providers.fetchMetArtworks({ location, year, limit: MAX_RESULTS });
  }
  return Promise.resolve([]);
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
    const subtitle = [item.artist, item.date, item.location || item.source].filter(Boolean).join(" • ");
    card.innerHTML = `
      <img src="${item.thumb}" alt="${item.title}" loading="lazy" />
      <div class="meta">
        <div class="title">${item.title || "Untitled"}</div>
        <div class="subtitle">${subtitle}</div>
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
    const items = await fetchArtworks({ location, year });
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

