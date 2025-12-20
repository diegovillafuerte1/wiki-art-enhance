// Core content script for Wikipedia Art Companion
// Heuristic parsing + Met Museum lookup + tooltip injection

const CONTEXT_SCAN_LIMIT = 12000; // allow larger snippets for LLM
const TOOLTIP_RESULTS_LIMIT = 8; // per-provider fetch limit for tooltip
const TOOLTIP_WIDTH = 280;
const HIDE_DELAY_MS = 200;
const NLP_CHUNK_SIZE = 12000;
const NLP_SCROLL_THRESHOLD = 0.5; // trigger next scan when within 50% of the current scanned end
const renderedMarkers = new Set(); // track rendered (location + range) to avoid duplicate popups

function canonicalLocation(loc) {
  return (loc || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toRangeFromYear(year) {
  if (year == null) return null;
  return { start: year, end: year };
}

function midYearFromRange(range) {
  if (!range) return null;
  const { start, end } = range;
  if (start != null && end != null) return Math.round((start + end) / 2);
  return start != null ? start : end != null ? end : null;
}

function formatRange(range) {
  if (!range) return "";
  const { start, end } = range;
  if (start != null && end != null) {
    if (start === end) return String(start);
    return `${start}–${end}`;
  }
  return String(start ?? end ?? "");
}

const EXT = typeof browser !== "undefined" ? browser : chrome;
const DEBUG = true;

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
  const apiKey = await getStoredApiKey().catch(() => null);
  if (!apiKey) {
    dbg("llm:skip-no-key");
    return [];
  }
  const bodyText = document.body.innerText.slice(0, CONTEXT_SCAN_LIMIT);
  const prompt = `
Given the following Wikipedia text, list up to 5 (location, year) pairs that best describe places and times referenced. Prefer concrete places (city/country/venue/organization HQ) and specific years or decades if exact years missing.

Return JSON array of objects: [{"location":"...", "year": 1999}, ...] with year as a single number if possible (use an indicative year in a decade if only decade is given).

Text:
${bodyText.slice(0, 5000)}
`;
  try {
    const raw = await callLLM({ prompt, apiKey });
    dbg("llm:raw", raw);
    const jsonMatch = raw.match(/\[.*\]/s);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error("LLM result not array");
    const cleaned = parsed
      .map((item) => ({
        location: (item.location || "").toString().trim(),
        dateRange: item.year ? toRangeFromYear(parseInt(item.year, 10)) : null
      }))
      .filter((i) => i.location);
    dbg("llm:cleaned", cleaned);
    return cleaned;
  } catch (e) {
    dbg("llm:error", e);
    return [];
  }
}

async function extractWithNLP() {
  const res = await extractWithNLPRange(0, CONTEXT_SCAN_LIMIT);
  dbg("nlp:sample", res.slice(0, 5));
  return res;
}

async function extractWithNLPRange(offset, length) {
  if (!window.WACNlp || typeof window.WACNlp.extractCandidates !== "function") {
    return [];
  }
  try {
    const text = document.body?.innerText || "";
    const candidates = window.WACNlp.extractCandidates({
      text,
      offset,
      length
    });
    dbg("nlp:range", { offset, length, count: candidates?.length });
    return Array.isArray(candidates) ? candidates : [];
  } catch (e) {
    dbg("nlp:range-error", e);
    return [];
  }
}

function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const locKey = canonicalLocation(item.location);
    if (!locKey) continue;
    const rangeKey = item.dateRange ? `${item.dateRange.start || ""}-${item.dateRange.end || ""}` : "";
    const key = `${locKey}|${rangeKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function addNewCandidates(existing, incoming) {
  const merged = dedupeCandidates([...existing, ...incoming].filter(Boolean));
  return merged;
}

function fetchArtworks({ location, dateRange }) {
  const year = midYearFromRange(dateRange);
  const providers = window.WACProviders || {};
  dbg("fetch:start", { location, year, providers: Object.keys(providers || {}) });
  if (providers.fetchRelatedArtworks) {
    return providers.fetchRelatedArtworks({
      location,
      year,
      limitPerProvider: TOOLTIP_RESULTS_LIMIT
    });
  }
  if (providers.fetchMetArtworks) {
    return providers.fetchMetArtworks({
      location,
      year,
      limit: TOOLTIP_RESULTS_LIMIT
    });
  }
  return Promise.resolve([]);
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
function elementHasDateRange(elText, range) {
  if (!range) return false;
  const { start, end } = range;
  const numbers = (elText.match(/\d{3,4}/g) || []).map((n) => parseInt(n, 10));
  if (numbers.some((n) => n >= (start ?? n) && n <= (end ?? n))) return true;
  // Allow century phrases without explicit digits
  if (/\bcentur(?:y|ies)\b/i.test(elText)) return true;
  return false;
}

function findAnchors({ location, dateRange }) {
  const locKey = canonicalLocation(location);
  const els = Array.from(document.querySelectorAll("p, h1, h2, li"));
  if (dateRange) {
    return els.filter((el) => {
      const txtKey = canonicalLocation(el.innerText);
      return txtKey.includes(locKey) && elementHasDateRange(el.innerText, dateRange);
    });
  }
  return els.filter((el) => canonicalLocation(el.innerText).includes(locKey));
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

  /*
    Old algorithm (LLM + heuristic + lazy scan) is disabled per request to implement a new
    deterministic marking pass (red: location, blue: location+date, yellow: location+date+art).
  */

  const paragraphs = [];
  let consumed = 0;
  for (const p of Array.from(document.querySelectorAll("p"))) {
    const text = p.innerText || "";
    if (consumed >= CONTEXT_SCAN_LIMIT) break;
    paragraphs.push(p);
    consumed += text.length;
  }

  const pendingFetch = [];

  dbg("debug:paragraph-count", paragraphs.length);

  const detectRange = (text) => {
    // year range 1900-1933
    const range = text.match(/(1[0-9]{3}|20[0-9]{2})\s*[-–]\s*(1[0-9]{3}|20[0-9]{2})/);
    if (range) return { start: parseInt(range[1], 10), end: parseInt(range[2], 10) };
    const single = text.match(/(1[0-9]{3}|20[0-9]{2})/);
    if (single) {
      const y = parseInt(single[1], 10);
      return { start: y, end: y };
    }
    const century = text.match(/\b(\d{1,2})(st|nd|rd|th)?\s+centur(?:y|ies)\b/i);
    if (century) {
      const c = parseInt(century[1], 10);
      const base = (c - 1) * 100;
      return { start: base, end: base + 99 };
    }
    return null;
  };

function wrapAtIndex(anchor, start, length) {
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT, null);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const end = offset + node.data.length;
    if (start >= offset && start < end) {
      const localStart = start - offset;
      const localEnd = localStart + length;
      const before = node.data.slice(0, localStart);
      const mid = node.data.slice(localStart, localEnd);
      const after = node.data.slice(localEnd);
      const mark = document.createElement("mark");
      mark.className = "wac-marker";
      mark.textContent = mid;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode.replaceChild(frag, node);
      return mark;
    }
    offset = end;
  }
  return null;
}

  paragraphs.forEach((p) => {
    const text = p.innerText || "";
    const locs = nlp(text).places().out("array");
    dbg("debug:places", { text: text.slice(0, 80) + (text.length > 80 ? "..." : ""), locs });
    // Build positions map to avoid reusing the same occurrence
    const lower = text.toLowerCase();
    const positionsByLoc = new Map();
    locs.forEach((raw) => {
      const key = canonicalLocation(raw);
      if (!key) return;
      const arr = positionsByLoc.get(key) || [];
      positionsByLoc.set(key, arr);
    });
    positionsByLoc.forEach((arr, key) => {
      let from = 0;
      while (from < lower.length) {
        const pos = lower.indexOf(key, from);
        if (pos === -1) break;
        arr.push(pos);
        from = pos + key.length;
      }
    });

    positionsByLoc.forEach((positions, key) => {
      positions.forEach((startPos) => {
        const range = detectRange(text.slice(0, startPos));
        const marker = wrapAtIndex(p, startPos, key.length);
        if (!marker) return;
        marker.dataset.wacKey = `${key}-${range ? `${range.start}-${range.end}` : "noloc"}`;
        marker.classList.add("wac-marker-loc"); // red by default
        if (range) {
          marker.classList.remove("wac-marker-loc");
          marker.classList.add("wac-marker-noart"); // blue
          pendingFetch.push({ marker, location: key, dateRange: range });
        }
      });
    });
  });

  pendingFetch.forEach((item) => {
    fetchArtworks({ location: item.location, dateRange: item.dateRange })
      .then((arts) => {
        if (arts && arts.length > 0) {
          item.marker.classList.remove("wac-marker-noart");
          item.marker.classList.add("wac-marker-art"); // yellow
        }
      })
      .catch(() => {
        // leave as blue on error
      });
  });
}

function renderCandidates(candidates) {
  const anchorLocSeen = new Set();
  for (const candidate of candidates) {
    if (!candidate.location) {
      dbg("marker:skip-no-location", candidate);
      continue;
    }
    const locKey = canonicalLocation(candidate.location);
    if (!locKey) {
      dbg("marker:skip-bad-location", candidate);
      continue;
    }
    const rangeKey = candidate.dateRange ? `${candidate.dateRange.start || ""}-${candidate.dateRange.end || ""}` : "";
    const dedupeKey = `${locKey}|${rangeKey}`;
    const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(dedupeKey) : dedupeKey.replace(/"/g, '\\"');
    dbg("marker:render", { dedupeKey, locKey, rangeKey, raw: candidate });
    const anchors = findAnchors(candidate);
    if (!anchors || anchors.length === 0) {
      dbg("marker:skip-no-anchor", candidate);
      continue;
    }
    anchors.forEach((anchor, idx) => {
      dbg("init:anchor", { idx, candidate, anchorTag: anchor?.tagName });
      const anchorLocKey = `${anchor.dataset.wacAnchorKey || ""}|${locKey}|${rangeKey}|${idx}`;
      const existingMark = anchor.querySelector(`mark.wac-marker[data-wac-key="${esc}"]`);
      if (existingMark || anchorLocSeen.has(anchorLocKey)) {
        dbg("marker:skip-anchor-dup", { anchorKey: anchor.dataset.wacAnchorKey, locKey, rangeKey, candidate, idx });
        return;
      }
      const anchorKey = anchor.dataset.wacAnchorKey || `anchor-${Math.random().toString(36).slice(2)}`;
      anchor.dataset.wacAnchorKey = anchorKey;
      anchorLocSeen.add(anchorLocKey);
      const marker = createMarker(candidate.location, anchor);
      if (!marker) {
        dbg("marker:skip-no-match", candidate);
        return;
      }
      marker.dataset.wacKey = dedupeKey;
      // Pass 1: all locations => red
      marker.classList.add("wac-marker-loc");

      // If no date range, stop here (location-only)
      if (!candidate.dateRange) return;

      // Pass 2: locations with date range => blue initially
      marker.classList.remove("wac-marker-loc", "wac-marker-art");
      marker.classList.add("wac-marker-noart");

      const tooltip = createTooltipShell();
      let hideTimer = null;
      updateTooltipContent(tooltip, { state: "loading" });

      fetchArtworks(candidate)
        .then((artworks) => {
          dbg("candidate:artworks", candidate, artworks?.length);
          if (artworks && artworks.length > 0) {
            // Pass 3: has art => yellow
            marker.classList.remove("wac-marker-noart", "wac-marker-loc");
            marker.classList.add("wac-marker-art");
            const [first] = artworks;
            const captionBits = [
              candidate.location
                ? `${candidate.location}${candidate.dateRange ? `, ${formatRange(candidate.dateRange)}` : ""}`
                : null,
              first.location || first.source || null
            ].filter(Boolean);
            updateTooltipContent(tooltip, {
              image: first.thumb,
              title: first.title || "Artwork",
              caption: captionBits.join(" • ") || "Related art",
              onShowMore: () => {
                const baseUrl = EXT && EXT.runtime && EXT.runtime.getURL ? EXT.runtime.getURL("gallery.html") : "gallery.html";
                const url = new URL(baseUrl, window.location.href);
                if (candidate.location) url.searchParams.set("location", candidate.location);
                if (candidate.dateRange?.start != null) url.searchParams.set("startYear", String(candidate.dateRange.start));
                if (candidate.dateRange?.end != null) url.searchParams.set("endYear", String(candidate.dateRange.end));
                window.open(url.toString(), "_blank");
              }
            });
          } else {
            // stays blue
            updateTooltipContent(tooltip, { state: "error" });
          }
        })
        .catch((err) => {
          dbg("candidate:fetch-error", err);
          // stays blue
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
    });
  }
}
// Defer to idle to reduce impact on page load
if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}

