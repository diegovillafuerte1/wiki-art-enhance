// Core content script for Wikipedia Art Companion
// Heuristic parsing + Met Museum lookup + tooltip injection

const CONTEXT_SCAN_LIMIT = 12000; // allow larger snippets for LLM
const YEAR_PADDING = 20; // +/- years around found year for search range
const MAX_RESULTS = 8; // limit number of artworks to fetch
const TOOLTIP_WIDTH = 280;
const CACHE_TTL_MS = 5 * 60 * 1000;
const HIDE_DELAY_MS = 200;

const EXT = typeof browser !== "undefined" ? browser : chrome;
const DEBUG = true;
const metCache = new Map(); // key -> { ts, data, promise }

function dbg(...args) {
  if (!DEBUG) return;
  try {
    console.info("[WAC]", ...args);
  } catch (_) {
    // ignore logging issues
  }
}

function extractYear(text) {
  const match = text.match(/(1[5-9]\d{2}|20\d{2})/);
  return match ? parseInt(match[1], 10) : null;
}

function extractLocationFromInfobox() {
  const infobox = document.querySelector(".infobox");
  if (!infobox) return null;
  const rows = Array.from(infobox.querySelectorAll("tr"));
  for (const row of rows) {
    const heading = row.querySelector("th");
    if (!heading) continue;
    const label = heading.innerText.toLowerCase();
    if (["location", "place", "country", "city"].some((k) => label.includes(k))) {
      const cell = row.querySelector("td");
      if (cell) {
        const cellText = cell.innerText.trim();
        const locMatch = cellText.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})\b/);
        if (locMatch) return locMatch[1];
      }
    }
  }
  return null;
}

function extractHeadingLocation() {
  const heading = document.querySelector("#firstHeading");
  if (!heading) return null;
  const headingText = heading.innerText.replace(/\(.*?\)/g, "").trim();
  const locMatch = headingText.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})\b/);
  return locMatch ? locMatch[1] : null;
}

function extractArticleContext() {
  const bodyText = document.body.innerText.slice(0, CONTEXT_SCAN_LIMIT);
  const year = extractYear(bodyText);

  let location = extractLocationFromInfobox();
  if (!location) location = extractHeadingLocation();
  if (!location) {
    const leadPara = document.querySelector("p");
    if (leadPara) {
      const locMatch = leadPara.innerText.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})\b/);
      if (locMatch) location = locMatch[1];
    }
  }
  return { year, location };
}

async function extractWithLLM() {
  const bodyText = document.body.innerText.slice(0, CONTEXT_SCAN_LIMIT);
  const prompt = `
Given the following Wikipedia text, list up to 5 (location, year) pairs that best describe places and times referenced. Prefer concrete places (city/country/venue/organization HQ) and specific years or decades if exact years missing.

Return JSON array of objects: [{"location":"...", "year": 1999}, ...] with year as a single number if possible (use an indicative year in a decade if only decade is given).

Text:
${bodyText.slice(0, 5000)}
`;
  try {
    const raw = await callLLM({ prompt });
    dbg("llm:raw", raw);
    const jsonMatch = raw.match(/\[.*\]/s);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error("LLM result not array");
    const cleaned = parsed
      .map((item) => ({
        location: (item.location || "").toString().trim(),
        year: item.year ? parseInt(item.year, 10) : null
      }))
      .filter((i) => i.location);
    dbg("llm:cleaned", cleaned);
    return cleaned;
  } catch (e) {
    dbg("llm:error", e);
    return [];
  }
}

function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = `${(item.location || "").toLowerCase()}|${item.year || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function fetchMetArtworks({ location, year }) {
  dbg("fetch:start", { location, year });
  const key = `${location || ""}|${year || ""}`;
  const now = Date.now();
  const cached = metCache.get(key);
  if (cached && cached.data && cached.ts + CACHE_TTL_MS > now) {
    dbg("fetch:cache-hit", { key, count: cached.data.length });
    return cached.data;
  }
  if (cached && cached.promise) {
    dbg("fetch:cache-promise", { key });
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
          thumb: obj.primaryImageSmall,
          full: obj.primaryImage
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
    dbg("fetch:done", { key, count: data.length });
    return data;
  } catch (err) {
    dbg("fetch:error", err);
    metCache.delete(key);
    throw err;
  }
}

function createTooltipShell() {
  const tooltip = document.createElement("div");
  tooltip.className = "wac-tooltip";
  tooltip.innerHTML = `
    <div class="wac-thumb-wrap">
      <div class="wac-loading">Loading…</div>
    </div>
    <div class="wac-meta">
      <div class="wac-title">Fetching art…</div>
      <div class="wac-caption">Please wait</div>
      <button class="wac-more" disabled>Show more</button>
    </div>
  `;
  document.body.appendChild(tooltip);
  return tooltip;
}

function updateTooltipContent(tooltip, payload) {
  const thumbWrap = tooltip.querySelector(".wac-thumb-wrap");
  const titleEl = tooltip.querySelector(".wac-title");
  const captionEl = tooltip.querySelector(".wac-caption");
  const moreBtn = tooltip.querySelector(".wac-more");

  if (payload.state === "error") {
    thumbWrap.innerHTML = `<div class="wac-loading">No image</div>`;
    titleEl.textContent = "No related art found";
    captionEl.textContent = "Try another section or refine query.";
    moreBtn.disabled = true;
    return;
  }

  if (payload.state === "loading") {
    thumbWrap.innerHTML = `<div class="wac-loading">Loading…</div>`;
    titleEl.textContent = "Fetching art…";
    captionEl.textContent = "Please wait";
    moreBtn.disabled = true;
    return;
  }

  const { image, title, caption, onShowMore } = payload;
  thumbWrap.innerHTML = `<img src="${image}" alt="${title}" />`;
  titleEl.textContent = title || "Artwork";
  captionEl.textContent = caption || "";
  moreBtn.disabled = false;
  moreBtn.onclick = (e) => {
    e.preventDefault();
    onShowMore();
  };
}
function findAnchorElement({ location, year }) {
  const candidates = Array.from(document.querySelectorAll("p, h1, h2, li"));
  for (const el of candidates) {
    const text = el.innerText;
    if (location && text.includes(location)) return el;
    if (year && text.includes(String(year))) return el;
  }
  return document.querySelector("p") || document.body;
}

function wrapFirstMatch(node, needle) {
  if (!needle) return null;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
  const lowerNeedle = needle.toLowerCase();
  while (walker.nextNode()) {
    const txt = walker.currentNode;
    const idx = txt.data.toLowerCase().indexOf(lowerNeedle);
    if (idx !== -1) {
      const mark = document.createElement("mark");
      mark.className = "wac-marker";
      const before = txt.data.slice(0, idx);
      const match = txt.data.slice(idx, idx + needle.length);
      const after = txt.data.slice(idx + needle.length);
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      mark.textContent = match;
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));
      txt.parentNode.replaceChild(frag, txt);
      return mark;
    }
  }
  return null;
}

function createMarker(text, anchor) {
  const full = text || "";
  const firstSegment = full.split(",")[0].trim();
  const firstWord = full.split(/\s+/)[0] || "";

  let marker = wrapFirstMatch(anchor, full);
  if (!marker && firstSegment && firstSegment.length >= 3) {
    marker = wrapFirstMatch(anchor, firstSegment);
  }
  if (!marker && firstWord && firstWord.length >= 3) {
    marker = wrapFirstMatch(anchor, firstWord);
  }
  return marker; // may be null if no match in text
}

function positionTooltip(marker, tooltip) {
  const rect = marker.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 8;
  let left = rect.left + window.scrollX;
  const maxLeft = window.scrollX + window.innerWidth - TOOLTIP_WIDTH - 12;
  if (left > maxLeft) left = maxLeft;
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

async function init() {
  dbg("init:start");
  // Cleanup any prior injected markers/tooltips to avoid leftovers
  document.querySelectorAll(".wac-marker, .wac-tooltip").forEach((el) => el.remove());

  const heuristic = extractArticleContext();
  dbg("init:context", heuristic);

  let candidates = [];
  try {
    const llmCandidates = await extractWithLLM();
    candidates = dedupeCandidates([
      ...llmCandidates,
      heuristic
    ].filter(Boolean));
  } catch (e) {
    dbg("init:llm-error", e);
    candidates = [heuristic];
  }

  // filter out empties
  candidates = candidates.filter((c) => c && (c.location || c.year));
  if (candidates.length === 0) return;
  dbg("init:candidates", candidates);

  for (const candidate of candidates) {
    const anchor = findAnchorElement(candidate);
    dbg("init:anchor", candidate, anchor?.tagName);
    const marker = createMarker(candidate.location || "Art", anchor);
    if (!marker) {
      dbg("marker:skip-no-match", candidate);
      continue;
    }
    const tooltip = createTooltipShell();
    let hideTimer = null;
    updateTooltipContent(tooltip, { state: "loading" });

    fetchMetArtworks(candidate)
      .then((artworks) => {
        dbg("candidate:artworks", candidate, artworks?.length);
        if (artworks && artworks.length > 0) {
          const [first] = artworks;
          updateTooltipContent(tooltip, {
            image: first.thumb,
            title: first.title || "Artwork",
            caption: candidate.location
              ? `${candidate.location}${candidate.year ? `, ${candidate.year}` : ""}`
              : "Related art",
            onShowMore: () => {
              const baseUrl = EXT && EXT.runtime && EXT.runtime.getURL ? EXT.runtime.getURL("gallery.html") : "gallery.html";
              const url = new URL(baseUrl, window.location.href);
              if (candidate.location) url.searchParams.set("location", candidate.location);
              if (candidate.year) url.searchParams.set("year", String(candidate.year));
              window.open(url.toString(), "_blank");
            }
          });
        } else {
          updateTooltipContent(tooltip, { state: "error" });
        }
      })
      .catch((err) => {
        dbg("candidate:fetch-error", err);
        updateTooltipContent(tooltip, { state: "error" });
      });

    const show = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      dbg("marker:hover", candidate);
      positionTooltip(marker, tooltip);
      tooltip.classList.add("wac-visible");
    };

    const hide = () => {
      hideTimer = setTimeout(() => {
        tooltip.classList.remove("wac-visible");
        hideTimer = null;
      }, HIDE_DELAY_MS);
    };

    marker.addEventListener("mouseenter", show);
    marker.addEventListener("mouseleave", hide);
    tooltip.addEventListener("mouseenter", show);
    tooltip.addEventListener("mouseleave", hide);
  }
}

// Defer to idle to reduce impact on page load
if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}

