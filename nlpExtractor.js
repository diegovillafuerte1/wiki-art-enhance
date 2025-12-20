// NLP-based extractor for locations and nearest dates using compromise
// Provides window.WACNlp.extractCandidates()
/* global nlp */

(function () {
  const CONTEXT_SCAN_LIMIT = 12000;
  const MAX_CANDIDATES = 10;
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
    const regex = /(1[5-9]\d{2}|20\d{2})/g;
    let match;
    while ((match = regex.exec(text))) {
      years.push(parseInt(match[1], 10));
    }
    return years;
  }

  function nearestYear(sentenceIdx, datesBySentence) {
    if (!datesBySentence || !datesBySentence.length) return null;
    const maxRadius = Math.max(datesBySentence.length, 1);
    for (let radius = 0; radius <= maxRadius; radius++) {
      const prev = sentenceIdx - radius;
      const next = sentenceIdx + radius;
      if (prev >= 0 && datesBySentence[prev] && datesBySentence[prev].length) {
        return datesBySentence[prev][0];
      }
      if (next < datesBySentence.length && datesBySentence[next] && datesBySentence[next].length) {
        return datesBySentence[next][0];
      }
    }
    return null;
  }

  function collectDatesPerSentence(sentences) {
    ensureDatesPlugin();
    return sentences.map((sentenceText) => {
      const years = [];
      try {
        const doc = nlp(sentenceText).dates();
        // Prefer structured dates if available
        const json = typeof doc.json === "function" ? doc.json() : [];
        json.forEach((d) => {
          const meta = (d && d.dates && d.dates[0]) || {};
          if (meta.start && meta.start.year) years.push(meta.start.year);
          else if (meta.year) years.push(meta.year);
        });
        // Fallback: use string output + regex scan for 4-digit years
        const dateStrings = typeof doc.out === "function" ? doc.out("array") : [];
        dateStrings
          .map(parseYears)
          .flat()
          .forEach((yr) => years.push(yr));
      } catch (e) {
        // ignore and try regex-only fallback below
      }
      // Final fallback: regex scan of the raw sentence
      parseYears(sentenceText).forEach((yr) => years.push(yr));
      // dedupe per sentence
      return Array.from(new Set(years)).sort();
    });
  }

  function extractCandidates(options = {}) {
    if (typeof nlp !== "function") return [];
    const text = (options.text || document.body?.innerText || "").slice(0, CONTEXT_SCAN_LIMIT);
    if (!text) return [];

    const sentences = nlp(text).sentences().out("array");
    if (!sentences || sentences.length === 0) return [];

    const datesBySentence = collectDatesPerSentence(sentences);
    const seen = new Set();
    const candidates = [];

    sentences.forEach((sentenceText, idx) => {
      const placeStrings = nlp(sentenceText).places().out("array");
      if (!placeStrings || placeStrings.length === 0) return;

      const sentenceYears = datesBySentence[idx] || [];
      const chosenYear = sentenceYears[0] ?? nearestYear(idx, datesBySentence);

      placeStrings.forEach((place) => {
        const location = place.trim();
        if (!location) return;
        const key = `${location.toLowerCase()}|${chosenYear || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ location, year: chosenYear || null });
      });
    });

    return candidates.slice(0, MAX_CANDIDATES);
  }

  window.WACNlp = {
    extractCandidates
  };
})();

