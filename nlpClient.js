// Centralized extended compromise instance
// Bridge to ensure compromise is extended with compromise-dates in content scripts.
// Relies on globals provided by lib/compromise*.js and lib/compromise-dates*.js.
(function () {
  const g = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : null;
  const n = typeof nlp === "function" ? nlp : g && g.nlp ? g.nlp : null;
  const dates = g && g.compromiseDates ? g.compromiseDates : null;
  const hasDates = () => {
    try {
      const doc = n ? n("test") : null;
      return !!(doc && typeof doc.dates === "function");
    } catch (_) {
      return false;
    }
  };
  try {
    console.info("[WAC][nlpClient] start", {
      hasNlp: !!n,
      hasDatesGlobal: !!dates,
      hasDatesFn: hasDates(),
      hasDatesGlobalThis: !!(g && g.compromiseDates)
    });
  } catch (_) {
    // ignore logging issues
  }
  if (n && dates && typeof n.extend === "function") {
    try {
      n.extend(dates);
      try {
        console.info("[WAC][nlpClient] extended dates", { hasDatesFn: hasDates() });
      } catch (_) {
        // ignore
      }
    } catch (e) {
      try {
        console.warn("[WAC][nlpClient] extend error", e);
      } catch (_) {
        // ignore
      }
    }
  } else {
    try {
      console.warn("[WAC][nlpClient] missing dependencies", { hasNlp: !!n, hasDatesGlobal: !!dates, canExtend: !!(n && n.extend) });
    } catch (_) {
      // ignore
    }
  }
  if (typeof window !== "undefined" && n) {
    window.WACNlp = n;
  }
})();

