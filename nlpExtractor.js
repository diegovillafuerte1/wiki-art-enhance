// NLP-based extractor for locations and date ranges using compromise + chrono
// Provides window.WACNlp.extractCandidates()
/* global nlp, chrono */

(function () {
  const CONTEXT_SCAN_LIMIT = 12000;
  let datesExtended = false;

  function ensureDatesPlugin() {
    if (datesExtended) return;
    if (typeof window !== "undefined" && window.compromiseDates && typeof nlp?.extend === "function") {
      try {
        nlp.extend(window.compromiseDates);
        datesExtended = true;
      } catch (e) {
        // ignore; we will fall back to regex-only dates
      }
    }
  }

  function parseYears(text) {
    if (!text) return [];
    const years = [];
    const regex = /(1[0-9]\d{2}|20\d{2})/g; // allow medieval through 2099
    let match;
    while ((match = regex.exec(text))) {
      years.push(parseInt(match[1], 10));
    }
    return years;
  }

  function parseCenturyRange(text) {
    if (!text) return null;
    // Handle forms like:
    // - "early 16th century"
    // - "7th and 8th centuries"
    // - "7th–8th centuries"
    const multiMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:–|-|to|and)\s*(\d{1,2})(?:st|nd|rd|th)?\s+centur(?:y|ies)\b/i);
    if (multiMatch) {
      const c1 = parseInt(multiMatch[1], 10);
      const c2 = parseInt(multiMatch[2], 10);
      if (!Number.isNaN(c1) && !Number.isNaN(c2)) {
        const low = Math.min(c1, c2);
        const high = Math.max(c1, c2);
        return {
          start: (low - 1) * 100,
          end: (high - 1) * 100 + 99
        };
      }
    }

    const match = text.match(/\b(early|mid(?:dle)?|late|end|ending|beginning|start)?\s*(\d{1,2})(st|nd|rd|th)?\s+centur(?:y|ies)\b/i);
    if (!match) return null;
    const qualifier = match[1] ? match[1].toLowerCase() : "";
    const centuryNum = parseInt(match[2], 10);
    if (!centuryNum || Number.isNaN(centuryNum)) return null;
    const baseStart = (centuryNum - 1) * 100;
    let start = baseStart;
    let end = baseStart + 99;
    if (qualifier === "early" || qualifier === "beginning" || qualifier === "start") {
      end = baseStart + 33;
    } else if (qualifier === "mid" || qualifier === "middle") {
      start = baseStart + 34;
      end = baseStart + 66;
    } else if (qualifier === "late" || qualifier === "end" || qualifier === "ending") {
      start = baseStart + 67;
    }
    return { start, end };
  }

  function normalizeRange(start, end) {
    if (start == null && end == null) return null;
    const s = start != null ? start : end;
    const e = end != null ? end : start;
    if (s == null && e == null) return null;
    return { start: s, end: e };
  }

  function chronoRanges(text) {
    if (typeof chrono === "undefined" || !chrono?.parse) return [];
    try {
      const results = chrono.parse(text) || [];
      return results
        .map((res) => {
          const start = res.start?.get("year");
          const end = res.end?.get("year") ?? start;
          return normalizeRange(start, end);
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function nearestRange(sentenceIdx, rangesBySentence) {
    if (!rangesBySentence || !rangesBySentence.length) return null;
    const maxRadius = Math.max(rangesBySentence.length, 1);
    for (let radius = 0; radius <= maxRadius; radius++) {
      const prev = sentenceIdx - radius;
      const next = sentenceIdx + radius;
      if (prev >= 0 && rangesBySentence[prev] && rangesBySentence[prev].length) {
        return rangesBySentence[prev][0];
      }
      if (next < rangesBySentence.length && rangesBySentence[next] && rangesBySentence[next].length) {
        return rangesBySentence[next][0];
      }
    }
    return null;
  }

  function collectRangesPerSentence(sentences) {
    ensureDatesPlugin();
    return sentences.map((sentenceText) => {
      const ranges = [];
      try {
        const doc = nlp(sentenceText).dates();
        // Prefer structured dates if available
        const json = typeof doc.json === "function" ? doc.json() : [];
        json.forEach((d) => {
          const meta = (d && d.dates && d.dates[0]) || {};
          if (meta.start && meta.start.year) {
            ranges.push(normalizeRange(meta.start.year, meta.end?.year));
          } else if (meta.year) {
            ranges.push(normalizeRange(meta.year, meta.year));
          }
        });
        // Fallback: use string output + regex scan for 4-digit years
        const dateStrings = typeof doc.out === "function" ? doc.out("array") : [];
        dateStrings
          .map(parseYears)
          .flat()
          .forEach((yr) => ranges.push(normalizeRange(yr, yr)));
      } catch (e) {
        // ignore and try regex-only fallback below
      }
      // chrono-based ranges
      chronoRanges(sentenceText).forEach((r) => ranges.push(r));
      // century phrases
      const centuryRange = parseCenturyRange(sentenceText);
      if (centuryRange) ranges.push(centuryRange);
      // Final fallback: regex scan of the raw sentence
      parseYears(sentenceText).forEach((yr) => ranges.push(normalizeRange(yr, yr)));
      // dedupe per sentence
      const dedup = new Map();
      ranges.forEach((r) => {
        if (!r) return;
        const key = `${r.start || ""}|${r.end || ""}`;
        dedup.set(key, r);
      });
      const uniq = Array.from(dedup.values());
      // If multiple years/ranges, add a combined span to capture "from 1915 to 1918"
      const allYears = uniq
        .map((r) => [r.start, r.end])
        .flat()
        .filter((n) => typeof n === "number");
      if (allYears.length >= 2) {
        const min = Math.min(...allYears);
        const max = Math.max(...allYears);
        uniq.unshift({ start: min, end: max });
      }
      return uniq;
    });
  }

  function extractCandidates(options = {}) {
    const { offset = 0, length = CONTEXT_SCAN_LIMIT } = options;
    if (typeof nlp !== "function") return [];
    const raw = options.text || document.body?.innerText || "";
    const text = raw.slice(offset, offset + length);
    if (!text) return [];

    const sentences = nlp(text).sentences().out("array");
    if (!sentences || sentences.length === 0) return [];

    const rangesBySentence = collectRangesPerSentence(sentences);
    const seen = new Set();
    const candidates = [];

    sentences.forEach((sentenceText, idx) => {
      const placeStrings = nlp(sentenceText).places().out("array");
      if (!placeStrings || placeStrings.length === 0) return;

      const sentenceRanges = rangesBySentence[idx] || [];
      const chosenRange = sentenceRanges[0] ?? nearestRange(idx, rangesBySentence);

      placeStrings.forEach((place) => {
        const location = place
          .replace(/^[^\w]+/, "")
          .replace(/[^\w]+$/, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!location) return;
        const key = `${location.toLowerCase()}|${chosenRange ? `${chosenRange.start || ""}-${chosenRange.end || ""}` : ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ location, dateRange: chosenRange || null });
      });
    });

    return candidates;
  }

  window.WACNlp = {
    extractCandidates
  };
})();

