// ==UserScript==
// @name         Tempo ↔ PhoneTool Performance Recognition
// @namespace    dco.perf.recognition.fullsuite.v4_2
// @version      4.2.0
// @description  Captures Shift Utilization + Red Zone (RZN) from Tempo Shift Overview Lite (multi-week) and renders a PhoneTool widget with streak/rank + collapsible rules + RZ notes override + SU rank medal.
// @match        https://tempo.ciat.aws.dev/*
// @match        https://tempo*.ciat.aws.dev/*
// @match        https://phonetool.amazon.com/users/*
// @match        https://phonetool*.amazon.com/users/*
// @match        https://phonetool*.aws.dev/users/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  "use strict";

  // ------------------------------
  // CONFIG
  // ------------------------------
  const STORE_KEY = "tempo_perf_shared_fullsuite_v4_2";
  const RZ_NOTES_KEY = "tempo_perf_rz_notes_v4_2";

  const THRESHOLDS = {
    shiftUtilMin: 80,  // SU >= 80 passes
    rzGoodMin: 45,     // RZ >= 45 is GOOD
    rzWarnMin: 30,     // 30 <= RZ < 45 is NEEDS WORK
    // RZ < 30 is NEEDS IMPROVEMENT
  };

  const RANKS = [
    { name: "Bronze", minWeeks: 2 },
    { name: "Silver", minWeeks: 4 },
    { name: "Gold", minWeeks: 8 },
    { name: "Platinum", minWeeks: 12 },
  ];

  const CAPTURE = {
    throttleMs: 1200,
    weekLabelRegex: /^\d{2}$/,
    // DOM fallback anchors
    suKeywords: ["shift utilization"],
    rzKeywords: ["rzn", "red zone"],
    rejectZoneWords: ["zone type", "gzn", "yzn", "rzn", "red zone"],
    // If true, SU capture only accepts blocks containing "hours"
    requireHoursWordForSU: true,
    // Daily view date label patterns (Highcharts category strings)
    // Matches: "04/14", "4/14", "Apr 14", "April 14", "Mon", "Monday", "14"
    dayLabelRegexes: [
      /^(\d{1,2})\/(\d{1,2})$/,           // 04/14 or 4/14  (month/day)
      /^([A-Za-z]{3,9})\s+(\d{1,2})$/,    // Apr 14 / April 14
      /^([A-Za-z]{3,6})$/,                 // Mon / Monday (day-of-week only)
      /^(\d{1,2})$/,                       // bare day number like "14"
    ],
  };

  // ------------------------------
  // UTILS
  // ------------------------------
  function log(...args) { console.log("[PerfFullSuiteV4.2]", ...args); }
  function warn(...args) { console.warn("[PerfFullSuiteV4.2]", ...args); }
  function nowIso() { return new Date().toISOString(); }

  function loadSaved() { return GM_getValue(STORE_KEY, null); }
  function saveSaved(payload) { GM_setValue(STORE_KEY, payload); }

  function loadRZNotes() {
    const v = GM_getValue(RZ_NOTES_KEY, {});
    return (v && typeof v === "object") ? v : {};
  }
  function saveRZNotes(obj) { GM_setValue(RZ_NOTES_KEY, obj || {}); }

  function getRZNote(weekKey) {
    const notes = loadRZNotes();
    return (notes && notes[weekKey]) ? String(notes[weekKey]) : "";
  }
  function setRZNote(weekKey, note) {
    const notes = loadRZNotes();
    const trimmed = String(note || "").trim();
    if (!trimmed) delete notes[weekKey];
    else notes[weekKey] = trimmed;
    saveRZNotes(notes);
  }

  function pct(v) {
    return (typeof v === "number" && isFinite(v))
      ? `${v.toFixed(1).replace(/\.0$/, "")}%`
      : "—";
  }

  function parsePercent(text) {
    const m = String(text).match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? Number(m[1]) : null;
  }

  function getIsoWeekKey(d = new Date()) {
    // ISO week key like 2026-W09
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    const yyyy = date.getUTCFullYear();
    const ww = String(weekNo).padStart(2, "0");
    return `${yyyy}-W${ww}`;
  }

  function mergeHistory(prevHistory) {
    return (prevHistory && typeof prevHistory === "object") ? prevHistory : {};
  }

  // ── View mode detection ──
  // Returns "weekly" | "daily" | "unknown"
  // Checks the Tempo filter UI for the active Time Unit selection.
  function detectViewMode() {
    // Tempo renders a "Time Unit" dropdown or radio — look for selected/active value
    const pageText = document.body?.innerText || "";

    // Check for explicit "Daily" or "Weekly" labels near filter controls
    // Tempo's filter panel usually has text like "Time Unit" followed by the selection
    const filterArea = document.querySelector(
      '[class*="filter"], [class*="Filter"], [class*="controls"], [class*="Controls"], [id*="filter"]'
    );
    const searchText = (filterArea?.innerText || pageText).toLowerCase();

    // If the page explicitly says "daily" in a filter context, trust it
    if (/time\s*unit[^\n]{0,40}daily/i.test(searchText)) return "daily";
    if (/time\s*unit[^\n]{0,40}weekly/i.test(searchText)) return "weekly";

    // Fallback: look at Highcharts category labels to infer mode
    const HC = (typeof window !== "undefined") ? window.Highcharts : null;
    if (HC?.charts) {
      for (const chart of HC.charts.filter(Boolean)) {
        const cats = chart?.xAxis?.[0]?.categories || [];
        if (!cats.length) continue;
        const sample = String(cats[0] ?? "").trim();
        // Week numbers are 1–53 (1 or 2 digits)
        if (/^\d{1,2}$/.test(sample) && Number(sample) >= 1 && Number(sample) <= 53) return "weekly";
        // Date-like labels → daily
        if (/\d{1,2}\/\d{1,2}/.test(sample)) return "daily";
        if (/^[A-Za-z]{3,9}\s+\d{1,2}$/.test(sample)) return "daily";
        if (/^[A-Za-z]{3,6}$/.test(sample)) return "daily"; // Mon/Monday
      }
    }

    return "unknown";
  }

  // Convert a daily Highcharts category label to an ISO week key.
  // We need the year context since daily labels often omit it.
  // Returns e.g. "2026-W16" or null if unparseable.
  function dailyLabelToWeekKey(label, yearHint = new Date().getFullYear()) {
    const s = String(label ?? "").trim();
    if (!s) return null;

    // "04/14" or "4/14" → month/day
    const mdMatch = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (mdMatch) {
      const d = new Date(yearHint, Number(mdMatch[1]) - 1, Number(mdMatch[2]));
      if (!isNaN(d)) return getIsoWeekKey(d);
    }

    // "Apr 14" / "April 14"
    const monDayMatch = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
    if (monDayMatch) {
      const d = new Date(`${monDayMatch[1]} ${monDayMatch[2]}, ${yearHint}`);
      if (!isNaN(d)) return getIsoWeekKey(d);
    }

    // Bare day-of-week name ("Mon", "Monday") — map to current week
    const dowNames = ["sun","mon","tue","wed","thu","fri","sat","sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    if (dowNames.includes(s.toLowerCase())) return getIsoWeekKey();

    // Bare day number "14" — assume current month
    const dayOnly = s.match(/^(\d{1,2})$/);
    if (dayOnly) {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), Number(dayOnly[1]));
      if (!isNaN(d)) return getIsoWeekKey(d);
    }

    return null;
  }

  // RZ grading with your wording
  function gradeRZ(rzPct) {
    if (rzPct == null || Number.isNaN(rzPct)) {
      return { label: "No data", status: "nodata", ok: false };
    }
    if (rzPct >= THRESHOLDS.rzGoodMin) return { label: "Good", status: "good", ok: true };
    if (rzPct >= THRESHOLDS.rzWarnMin) return { label: "Needs work", status: "warn", ok: false };
    return { label: "Needs improvement", status: "bad", ok: false };
  }

  // A week passes if SU passes AND (RZ good OR RZ explained)
  function goodWeek(metrics, weekKey) {
    const su = metrics?.shiftUtilPct;
    const rz = metrics?.redZonePct;

    const suOk = (typeof su === "number") && su >= THRESHOLDS.shiftUtilMin;

    const rzGrade = gradeRZ(rz);
    const note = weekKey ? getRZNote(weekKey) : "";
    const explained = !!note && rzGrade.ok === false;

    const rzCountsAsPass = rzGrade.ok || explained;
    return suOk && rzCountsAsPass;
  }

  function computeStreak(history) {
    if (!history || typeof history !== "object") return 0;
    const keys = Object.keys(history).sort(); // ISO sorts correctly
    let streak = 0;
    for (let i = keys.length - 1; i >= 0; i--) {
      const wk = keys[i];
      if (goodWeek(history[wk]?.metrics, wk)) streak++;
      else break;
    }
    return streak;
  }

  function rankFor(streak) {
    let current = "Unranked";
    for (const r of RANKS) if (streak >= r.minWeeks) current = r.name;
    const next = RANKS.find(r => r.minWeeks > streak) || null;
    return { current, next: next?.name || null, toNext: next ? (next.minWeeks - streak) : 0 };
  }

  // ------------------------------
  // TOAST
  // ------------------------------
  function toast(msg, ok = true) {
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = `
      position: fixed; z-index: 999999;
      right: 16px; bottom: 16px;
      padding: 10px 12px; border-radius: 10px;
      font: 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      color: #fff;
      background: ${ok ? "rgba(46, 204, 113, .95)" : "rgba(231, 76, 60, .95)"};
      box-shadow: 0 10px 28px rgba(0,0,0,.25);
      max-width: 460px; white-space: pre-wrap;
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  // ------------------------------
  // TEMPO CAPTURE (Highcharts first, DOM fallback)
  // ------------------------------

  function tryCaptureFromHighcharts() {
    const HC = (typeof window !== "undefined") ? window.Highcharts : null;
    if (!HC || !HC.charts) return null;

    const charts = HC.charts.filter(Boolean);
    if (!charts.length) return null;

    const year = new Date().getFullYear();
    const viewMode = detectViewMode();
    const byWeek = {};

    // Resolve any category label (weekly OR daily) to an ISO week key
    const labelToKey = (label) => {
      const s = String(label ?? "").trim();
      if (!s) return null;

      // Weekly: bare 1–2 digit number = ISO week number
      const n = Number(s);
      if (Number.isFinite(n) && n >= 1 && n <= 53 && /^\d{1,2}$/.test(s)) {
        return `${year}-W${String(n).padStart(2, "0")}`;
      }

      // Daily: try to parse as a date label
      const dailyKey = dailyLabelToWeekKey(s, year);
      if (dailyKey) return dailyKey;

      return null;
    };

    const setMetric = (label, field, value) => {
      const key = labelToKey(label);
      if (!key) return;
      byWeek[key] = byWeek[key] || {};
      const num = (typeof value === "number" && isFinite(value)) ? value : null;
      if (num == null) return;
      // For daily view, multiple days roll up into the same week key.
      // For SU: keep the highest value seen (best representation of the week).
      // For RZ: keep the highest value seen.
      if (typeof byWeek[key][field] !== "number" || value > byWeek[key][field]) {
        byWeek[key][field] = num;
      }
    };

    charts.forEach(chart => {
      if (!chart?.series?.length) return;

      chart.series.forEach(series => {
        const name = String(series?.name || "").toLowerCase();
        if (!series?.points?.length) return;

        const isSU = name.includes("utilized") && !name.includes("unmeasured");
        const isRZ = name.includes("rzn") || name.includes("red zone");

        if (!isSU && !isRZ) return;

        series.points.forEach(p => {
          const label = p?.category ?? p?.name ?? null;
          const val = (typeof p?.y === "number") ? p.y : null;
          if (isSU) setMetric(label, "shiftUtilPct", val);
          if (isRZ) setMetric(label, "redZonePct", val);
        });
      });
    });

    const keys = Object.keys(byWeek);
    if (!keys.length) return null;

    return { byWeek, debug: { method: "highcharts", viewMode, chartsFound: charts.length, keys } };
  }

  // DOM fallback -- works for both weekly and daily view
  function collectTextNodes(root = document) {
    const hits = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = (node.nodeValue || "").trim();
        if (!t) return NodeFilter.FILTER_REJECT;
        const low = t.toLowerCase();

        // Accept week numbers AND daily date labels
        const isAxisLabel =
          CAPTURE.weekLabelRegex.test(t) ||           // "05" week number
          /^\d{1,2}\/\d{1,2}$/.test(t) ||            // "04/14" date
          /^[A-Za-z]{3,9}\s+\d{1,2}$/.test(t) ||     // "Apr 14"
          /^[A-Za-z]{3,6}$/.test(t);                  // "Mon"

        const useful =
          t.includes("%") ||
          isAxisLabel ||
          low.includes("shift utilization") ||
          low.includes("utilized") ||
          low.includes("rzn") ||
          low.includes("red zone") ||
          low.includes("hours") ||
          low.includes("zone type") ||
          low.includes("gzn") ||
          low.includes("yzn");

        return useful ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) hits.push(n);
    return hits;
  }

  function getNodeCenter(node) {
    const el = node?.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // Parse a DOM text node as either a week number OR a daily date label.
  // Returns { key: "2026-W16", raw: "04/14" } or null.
  function parseAxisLabel(text) {
    const t = String(text).trim();
    if (!t) return null;
    const year = new Date().getFullYear();

    // Weekly: 1–2 digit ISO week number
    if (CAPTURE.weekLabelRegex.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n) && n >= 1 && n <= 53) {
        return { key: `${year}-W${String(n).padStart(2, "0")}`, raw: t };
      }
    }

    // Daily: "04/14" or "4/14"
    const mdMatch = t.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (mdMatch) {
      const d = new Date(year, Number(mdMatch[1]) - 1, Number(mdMatch[2]));
      if (!isNaN(d)) return { key: getIsoWeekKey(d), raw: t };
    }

    // Daily: "Apr 14" / "April 14"
    const monDayMatch = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
    if (monDayMatch) {
      const d = new Date(`${monDayMatch[1]} ${monDayMatch[2]}, ${year}`);
      if (!isNaN(d)) return { key: getIsoWeekKey(d), raw: t };
    }

    // Daily: bare day-of-week ("Mon", "Monday") → current week
    const dowNames = ["sun","mon","tue","wed","thu","fri","sat","sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    if (dowNames.includes(t.toLowerCase())) {
      return { key: getIsoWeekKey(), raw: t };
    }

    return null;
  }

  // Build a list of axis label positions from DOM text nodes.
  // Each entry: { key: "2026-W16", pos: {x, y} }
  function findAxisLabels(hits) {
    const labels = [];
    for (const node of hits) {
      const parsed = parseAxisLabel(node.nodeValue);
      if (!parsed) continue;
      const pos = getNodeCenter(node);
      if (!pos) continue;
      labels.push({ key: parsed.key, raw: parsed.raw, pos });
    }
    // Prefer top-most instance of each label key
    const best = new Map();
    for (const l of labels) {
      const prev = best.get(l.key);
      if (!prev || l.pos.y < prev.pos.y) best.set(l.key, l);
    }
    return [...best.values()].sort((a, b) => a.pos.x - b.pos.x);
  }

  function nearestKeyByX(axisLabels, x) {
    if (!axisLabels.length) return null;
    let best = axisLabels[0];
    let bestDx = Math.abs(x - best.pos.x);
    for (const l of axisLabels) {
      const dx = Math.abs(x - l.pos.x);
      if (dx < bestDx) { best = l; bestDx = dx; }
    }
    return best.key;
  }

  function findDirectMetricPercents(hits, keywords, opts = {}) {
    const matches = [];
    const {
      rejectIfContains = [],
      ancestorDepth = 12,
      requireHoursWord = false,
    } = opts;

    function scanAncestors(el) {
      let cur = el;
      for (let i = 0; i < ancestorDepth && cur; i++) {
        const t = (cur.textContent || "").toLowerCase();

        for (const bad of rejectIfContains) {
          if (t.includes(bad)) return { ok: false };
        }

        for (const k of keywords) {
          if (t.includes(k)) {
            if (requireHoursWord && !t.includes("hours")) return { ok: false };
            return { ok: true };
          }
        }

        cur = cur.parentElement;
      }
      return { ok: false };
    }

    for (const node of hits) {
      const raw = (node.nodeValue || "").trim();
      const val = parsePercent(raw);
      if (val == null) continue;

      const parent = node.parentElement;
      if (!parent) continue;

      const res = scanAncestors(parent);
      if (!res.ok) continue;

      const pos = getNodeCenter(node);
      if (!pos) continue;

      matches.push({ value: val, pos, raw });
    }

    return matches;
  }

  function tryCaptureFromDOM() {
    const hits = collectTextNodes(document);
    const axisLabels = findAxisLabels(hits);
    const viewMode = detectViewMode();

    // SU: anchored to "shift utilization" and requires hours to avoid Zone Type confusion
    const suMatches = findDirectMetricPercents(hits, CAPTURE.suKeywords, {
      rejectIfContains: CAPTURE.rejectZoneWords,
      requireHoursWord: CAPTURE.requireHoursWordForSU,
    });

    // RZ: anchored to rzn/red zone, no hours requirement
    const rzMatches = findDirectMetricPercents(hits, CAPTURE.rzKeywords, {
      rejectIfContains: ["gzn", "yzn"], // allow rzn/red zone
      requireHoursWord: false,
    });

    const byWeek = {};

    for (const m of suMatches) {
      const key = nearestKeyByX(axisLabels, m.pos.x) || getIsoWeekKey();
      byWeek[key] = byWeek[key] || {};
      // keep highest SU found for that key (daily days roll up to same week key)
      const prev = byWeek[key].shiftUtilPct;
      if (typeof prev !== "number" || m.value > prev) byWeek[key].shiftUtilPct = m.value;
    }

    for (const m of rzMatches) {
      const key = nearestKeyByX(axisLabels, m.pos.x) || getIsoWeekKey();
      byWeek[key] = byWeek[key] || {};
      const prev = byWeek[key].redZonePct;
      if (typeof prev !== "number" || m.value > prev) byWeek[key].redZonePct = m.value;
    }

    const keys = Object.keys(byWeek);
    if (!keys.length) return null;

    return {
      byWeek,
      debug: {
        method: "dom",
        viewMode,
        axisLabels: axisLabels.map(l => l.raw),
        counts: { su: suMatches.length, rz: rzMatches.length },
        keys,
      }
    };
  }

  function saveCapture(byWeek, debugInfo) {
    const prev = loadSaved() || {};
    const history = mergeHistory(prev.history);

    const keys = Object.keys(byWeek).sort();
    for (const wkKey of keys) {
      history[wkKey] = {
        capturedAt: nowIso(),
        sourceUrl: location.href,
        metrics: {
          shiftUtilPct: (typeof byWeek[wkKey].shiftUtilPct === "number") ? byWeek[wkKey].shiftUtilPct : null,
          redZonePct: (typeof byWeek[wkKey].redZonePct === "number") ? byWeek[wkKey].redZonePct : null,
        }
      };
    }

    const latestKey = keys.length ? keys[keys.length - 1] : getIsoWeekKey();
    const latestMetrics = history[latestKey]?.metrics || { shiftUtilPct: null, redZonePct: null };

    const payload = {
      capturedAt: nowIso(),
      sourceUrl: location.href,
      weekKey: latestKey,
      metrics: { ...latestMetrics },
      history,
      debug: {
        ...debugInfo,
        savedWeeksThisCapture: keys,
      }
    };

    saveSaved(payload);
    return payload;
  }

  function tempoCaptureOnce(reason = "auto") {
    // Try Highcharts first
    const hc = tryCaptureFromHighcharts();
    if (hc?.byWeek) {
      const payload = saveCapture(hc.byWeek, { ...hc.debug, reason });
      toast(`Captured ✅  SU: ${payload.metrics.shiftUtilPct ?? "—"}%   RZ: ${payload.metrics.redZonePct ?? "—"}%`, true);
      log("Capture payload (Highcharts):", payload);
      return true;
    }

    // Fallback: DOM labels
    const dom = tryCaptureFromDOM();
    if (dom?.byWeek) {
      const payload = saveCapture(dom.byWeek, { ...dom.debug, reason });
      toast(`Captured ✅  SU: ${payload.metrics.shiftUtilPct ?? "—"}%   RZ: ${payload.metrics.redZonePct ?? "—"}%`, true);
      log("Capture payload (DOM):", payload);
      return true;
    }

    // If neither found anything, show helpful message
    const msg =
      "No data found yet ❌\n\nMake sure:\n• Filters are set (Technician + Local Week)\n• Bars show the % text inside them\n• Then use Tampermonkey menu → “Capture Now”";
    toast(msg, false);
    warn("Capture: no values found (yet).");
    return false;
  }

  function startTempoCapture() {
    log("Tempo module active:", location.href);

    // Manual command so you can do it AFTER filters populate
    GM_registerMenuCommand("PerfFullSuiteV4.2: Capture Now", () => tempoCaptureOnce("manual"));

    GM_registerMenuCommand("PerfFullSuiteV4.2: Show saved payload (console)", () => {
      log("Saved payload:", loadSaved());
      alert("Saved payload logged to console ✅");
    });

    GM_registerMenuCommand("PerfFullSuiteV4.2: Clear saved payload", () => {
      saveSaved(null);
      alert("Cleared saved payload ✅");
    });

    GM_registerMenuCommand("PerfFullSuiteV4.2: Clear RZ notes", () => {
      saveRZNotes({});
      alert("Cleared RZ notes ✅");
    });

    let last = 0;
    const throttled = (why = "mutation") => {
      const t = Date.now();
      if (t - last < CAPTURE.throttleMs) return;
      last = t;
      tempoCaptureOnce(why);
    };

    // Give page time to render, then attempt capture a few times
    setTimeout(() => throttled("startup@1.5s"), 1500);
    setTimeout(() => throttled("startup@3.0s"), 3000);
    setTimeout(() => throttled("startup@5.0s"), 5000);

    // Watch DOM changes (filters and chart renders cause mutations)
    const obs = new MutationObserver(() => throttled("mutation"));
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // Also poll lightly for a short period (covers “charts appear without many DOM mutations”)
    let polls = 0;
    const pollId = setInterval(() => {
      polls++;
      throttled("poll");
      if (polls >= 12) clearInterval(pollId); // ~24s total
    }, 2000);
  }

  // ------------------------------
  // PHONETOOL WIDGET (unchanged vibe)
  // ------------------------------
  function startPhoneToolWidget() {
    log("PhoneTool module active:", location.href);

    GM_registerMenuCommand("PerfFullSuiteV4.2: Show saved payload (console)", () => {
      log("Saved payload:", loadSaved());
      alert("Saved payload logged to console ✅");
    });

    GM_addStyle(`
      #perfWidgetLauncher {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        padding: 10px 12px; border-radius: 12px;
        border: 1px solid rgba(255,255,255,.18);
        background: rgba(104,98,255,.92);
        color: #fff;
        font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        cursor: pointer;
        box-shadow: 0 14px 36px rgba(0,0,0,.28);
        user-select:none;
      }

      #perfWidgetPanel {
        position: fixed; right: 18px; bottom: 62px; z-index: 2147483647;
        width: 580px; max-width: calc(100vw - 36px);
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,.16);
        box-shadow: 0 18px 46px rgba(0,0,0,.35);
        background: rgba(10,12,16,.92);
        display: none;
        overflow:auto;
        max-height: calc(100vh - 120px);
      }

      .pw-card {
        border-radius: 16px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.10);
        background: rgba(10,12,16,.65);
      }

      .pw-head {
        display:flex; justify-content:space-between; align-items:center;
        padding: 14px 16px;
        background: linear-gradient(90deg, rgba(104,98,255,.85), rgba(155,92,255,.75));
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }

      .pw-head h2 {
        margin:0;
        font-size: 16px;
        letter-spacing:.2px;
        color: #fff;
        font-weight: 900;
        display:flex; gap:10px; align-items:center;
      }

      .pw-updated { font-size: 12px; opacity:.92; color:#fff; }

      .pw-body {
        padding: 12px 14px 14px;
        color:#eaeef7;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }

      .pw-metrics {
        display:grid;
        grid-template-columns: repeat(2, minmax(0,1fr));
        gap: 10px;
        margin-bottom: 12px;
      }
      .pw-metric {
        background: rgba(255,255,255,.08);
        border:1px solid rgba(255,255,255,.10);
        border-radius: 14px;
        padding: 12px;
        text-align:center;
      }
      .pw-label { font-size: 12px; opacity:.9; margin-bottom: 6px; }
      .pw-value { font-size: 24px; font-weight: 900; display:flex; gap:10px; justify-content:center; align-items:center; }

      .pw-dot{
        width: 18px; height: 18px; border-radius: 4px;
        display:inline-flex; justify-content:center; align-items:center;
        background: rgba(46,204,113,.95);
        color:#fff !important;
        font-weight: 1000;
        text-shadow: 0 1px 2px rgba(0,0,0,.55);
        line-height: 1;
      }
      .pw-dot.bad  { background: rgba(231,76,60,.92);  color:#fff !important; }
      .pw-dot.warn { background: rgba(255,193,7,.92);  color:#1a1200 !important; text-shadow:none; }
      .pw-dot.info { background: rgba(90,200,250,.92); color:#06131d !important; text-shadow:none; }

      .pw-award {
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.10);
        border-radius: 14px;
        padding: 14px;
        margin: 10px 0;
        display:flex; justify-content:space-between; gap: 14px;
      }
      .pw-title { font-weight: 900; display:flex; gap:10px; align-items:center; }
      .pw-meta { font-size: 13px; opacity:.92; display:flex; gap: 12px; flex-wrap:wrap; margin-top: 4px; }
      .pw-badge {
        font-weight:900;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,.10);
        border:1px solid rgba(255,255,255,.12);
        white-space:nowrap;
        height: fit-content;
      }
      .pw-subtle { font-size: 12px; opacity:.85; }

      .pw-kv {
        display:grid;
        grid-template-columns: 180px 1fr;
        gap: 6px 12px;
        padding: 10px 12px;
        background: rgba(255,255,255,.05);
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 14px;
        font-size: 12px;
        line-height: 1.35;
      }
      .pw-kv .k { opacity:.85; }
      .pw-kv .v { font-weight: 700; word-break: break-word; }

      .pw-warn {
        padding: 12px;
        background: rgba(255,193,7,.15);
        border:1px solid rgba(255,193,7,.25);
        border-radius: 12px;
        color:#ffe8a3;
        margin-top: 10px;
        white-space: pre-wrap;
      }

      .pw-btnrow { display:flex; gap: 10px; margin-top: 10px; flex-wrap:wrap; }
      .pw-btn {
        cursor:pointer;
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(255,255,255,.10);
        border: 1px solid rgba(255,255,255,.14);
        color:#eaeef7;
        font-size: 12px;
        user-select:none;
      }

      .pw-details {
        margin-top: 10px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,.10);
        background: rgba(255,255,255,.04);
        overflow: hidden;
      }
      .pw-details summary {
        cursor: pointer;
        padding: 10px 12px;
        font-weight: 900;
        color: #eaeef7;
        list-style: none;
      }
      .pw-details summary::-webkit-details-marker { display:none; }
      .pw-details .pw-details-inner { padding: 0 12px 12px; }

      .pw-noteWrap {
        margin-top: 10px;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,.10);
        background: rgba(255,255,255,.04);
      }
      .pw-noteLabel {
        font-size: 12px;
        opacity: .9;
        margin-bottom: 6px;
        font-weight: 900;
      }

      .pw-noteInput{
        width:100%;
        box-sizing:border-box;
        border-radius:12px;
        border:1px solid rgba(255,255,255,.14);
        background: rgba(10,12,16,.55) !important;
        color:#eaeef7 !important;
        padding:10px 10px;
        font-size:12px;
        outline:none;
        min-height:64px;
        resize:vertical;
        caret-color:#eaeef7;
        color-scheme: dark;
      }
      .pw-noteInput:focus,
      .pw-noteInput:active{
        background: rgba(10,12,16,.72) !important;
        border-color: rgba(155,92,255,.55) !important;
        box-shadow: 0 0 0 3px rgba(155,92,255,.18) !important;
      }

      .pw-medal {
        width: 26px;
        height: 26px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        border-radius: 10px;
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.10);
        box-shadow: 0 10px 22px rgba(0,0,0,.22);
        overflow:hidden;
      }

      @media (max-width: 840px) { .pw-metrics { grid-template-columns: 1fr; } }
    `);

    function dotClassForRZ(rzGrade, explained) {
      if (explained) return "info";
      if (rzGrade.status === "good") return "";
      if (rzGrade.status === "warn") return "warn";
      if (rzGrade.status === "bad") return "bad";
      return "bad";
    }

    function dotCharForRZ(rzGrade, explained) {
      if (explained) return "i";
      if (rzGrade.status === "good") return "✓";
      if (rzGrade.status === "warn") return "!";
      if (rzGrade.status === "bad") return "×";
      return "!";
    }

    function dot(ok) {
      return `<span class="pw-dot ${ok ? "" : "bad"}">${ok ? "✓" : "!"}</span>`;
    }

    function medalSvg(rankName) {
      const palette = {
        Unranked: { edge: "#9aa4b2", glow: "rgba(154,164,178,.35)", fill: "rgba(154,164,178,.10)" },
        Bronze:   { edge: "#cd7f32", glow: "rgba(205,127,50,.35)",  fill: "rgba(205,127,50,.12)" },
        Silver:   { edge: "#c0c0c0", glow: "rgba(192,192,192,.38)", fill: "rgba(192,192,192,.12)" },
        Gold:     { edge: "#d4af37", glow: "rgba(212,175,55,.38)",  fill: "rgba(212,175,55,.12)" },
        Platinum: { edge: "#b5f3ff", glow: "rgba(181,243,255,.40)", fill: "rgba(181,243,255,.12)" },
      };
      const key = palette[rankName] ? rankName : "Unranked";
      const { edge, glow, fill } = palette[key];

      return `
        <span class="pw-medal" title="SU Rank Medal: ${key}">
          <svg viewBox="0 0 64 64" width="24" height="24" aria-hidden="true">
            <defs>
              <filter id="g" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="0" stdDeviation="2.2" flood-color="${glow}"/>
              </filter>
            </defs>
            <path filter="url(#g)" d="M32 4 54 17v30L32 60 10 47V17L32 4Z" fill="${fill}" stroke="${edge}" stroke-width="3" />
            <path d="M32 16l4.2 8.6 9.5 1.4-6.9 6.7 1.6 9.4-8.4-4.4-8.4 4.4 1.6-9.4-6.9-6.7 9.5-1.4L32 16Z"
                  fill="${edge}" opacity="0.95"/>
          </svg>
        </span>
      `;
    }

    function renderSavedWeeksTable(history) {
      const keys = Object.keys(history || {}).sort();
      if (!keys.length) return `<div class="pw-subtle">No weeks saved yet.</div>`;

      const rows = keys.slice(-14).map(k => {
        const m = history[k]?.metrics || {};
        const su = m.shiftUtilPct;
        const rz = m.redZonePct;

        const rzGrade = gradeRZ(rz);
        const note = getRZNote(k);
        const explained = !!note && rzGrade.ok === false;

        const pass = goodWeek(m, k);
        const rzLabel = (explained && !rzGrade.ok) ? "" : rzGrade.label;

        return `
          <div class="pw-kv" style="margin-top:10px;">
            <div class="k">${k}</div>
            <div class="v">${pass ? "✅ PASS" : "—"}</div>

            <div class="k">SU</div>
            <div class="v">${pct(su)}</div>

            <div class="k">RZ</div>
            <div class="v">${pct(rz)}${rzLabel ? ` • <span style="opacity:.85">${rzLabel}</span>` : ""}${note ? ` • <span style="opacity:.85">"${note.replace(/</g,"&lt;")}"</span>` : ""}</div>
          </div>
        `;
      }).join("");

      return rows + `<div class="pw-subtle" style="margin-top:10px;">Showing last ${Math.min(14, keys.length)} saved weeks.</div>`;
    }

    function buildHtml(saved) {
      const m = saved?.metrics || {};
      const su = m.shiftUtilPct;
      const rz = m.redZonePct;

      const suOk = typeof su === "number" ? su >= THRESHOLDS.shiftUtilMin : false;

      const weekKey = saved?.weekKey || "—";
      const note = weekKey !== "—" ? getRZNote(weekKey) : "";
      const rzGrade = gradeRZ(rz);
      const explained = !!note && rzGrade.ok === false;

      const rzCountsAsPass = rzGrade.ok || explained;
      const weekPass = (typeof su === "number" ? suOk : false) && rzCountsAsPass;

      const streak = computeStreak(saved?.history);
      const rank = rankFor(streak);

      const updatedAt = saved?.capturedAt ? new Date(saved.capturedAt).toLocaleString() : "—";
      const refreshNote = `· auto-refreshes every 30s`;
      const sourceUrl = saved?.sourceUrl || "—";

      const rzDotClass = dotClassForRZ(rzGrade, explained);
      const rzDotChar = dotCharForRZ(rzGrade, explained);
      const rzLabel = (explained && !rzGrade.ok) ? "" : rzGrade.label;

      const warnBlock = (!saved || (su == null && rz == null))
        ? `No Tempo data found yet.

Fix steps:
1) Open Tempo → Shift Overview Lite
2) Set filters (Technician + Local Week)
3) Wait until % text appears inside bars
4) Tampermonkey menu → “Capture Now”
5) Refresh PhoneTool and open widget`
        : null;

      return `
        <div class="pw-card">
          <div class="pw-head">
            <h2>📊 Current Performance</h2>
            <div class="pw-updated">Updated: ${updatedAt} <span style="opacity:.7;font-size:11px;">${refreshNote}</span></div>
          </div>

          <div class="pw-body">
            <div class="pw-metrics">
              <div class="pw-metric">
                <div class="pw-label">Shift Utilization</div>
                <div class="pw-value">
                  ${medalSvg(rank.current)}
                  ${pct(su)}
                  ${dot(suOk)}
                </div>
              </div>

              <div class="pw-metric">
                <div class="pw-label">Red Zone Time</div>
                <div class="pw-value">
                  ${pct(rz)}
                  <span class="pw-dot ${rzDotClass}">${rzDotChar}</span>
                </div>
                ${rzLabel ? `
                  <div class="pw-subtle" style="margin-top:6px;">
                    Status: <b>${rzLabel}</b>
                  </div>
                ` : ``}
              </div>
            </div>

            <div class="pw-award">
              <div>
                <div class="pw-title">⚡ Operational Excellence</div>
                <div class="pw-meta">
                  <span>🔥 <b>${streak}</b> week streak</span>
                  ${rank.next ? `<span class="pw-subtle">${rank.toNext} weeks to ${rank.next}</span>` : `<span class="pw-subtle">Max rank achieved</span>`}
                  ${saved ? `<span class="pw-subtle">This week: ${weekPass ? "✅ PASS" : "—"}</span>` : ""}
                </div>

                <div class="pw-subtle" style="margin-top:6px;">
                  Pass criteria: SU ≥ ${THRESHOLDS.shiftUtilMin}% AND (RZ ≥ ${THRESHOLDS.rzGoodMin}% OR Explained)
                </div>

                ${rzLabel ? `
                  <div class="pw-subtle" style="margin-top:4px;">
                    RZ Status: <b>${rzLabel}</b>
                  </div>
                ` : ``}
              </div>

              <div class="pw-badge">${rank.current}</div>
            </div>

            <div class="pw-noteWrap">
              <div class="pw-noteLabel">RZ Action / Reason (optional) — Week ${weekKey}</div>
              <textarea class="pw-noteInput" id="pw-rz-note" placeholder="Example: staffing shortage, outage, training day, coverage role, assigned task...">${note ? note.replace(/</g,"&lt;") : ""}</textarea>
              <div class="pw-btnrow">
                <div class="pw-btn" id="pw-save-note">Save note</div>
                <div class="pw-btn" id="pw-clear-note">Clear note</div>
              </div>
              <div class="pw-subtle" style="margin-top:6px;">
                If your RZ is below ${THRESHOLDS.rzGoodMin}% but you document why, the week can still count for streak/rank.
              </div>
            </div>

            <details class="pw-details">
              <summary>Data & Rules</summary>
              <div class="pw-details-inner">
                <div class="pw-kv">
                  <div class="k">Data source</div>
                  <div class="v">Tempo “Shift Overview Lite” (multi-week)</div>

                  <div class="k">Capture method</div>
                  <div class="v">Highcharts points first (stable) → DOM label fallback if needed.</div>

                  <div class="k">Multi-week behavior</div>
                  <div class="v">If Tempo shows multiple weeks (05–09), each week saves separately for accurate streak/rank.</div>

                  <div class="k">Current snapshot week</div>
                  <div class="v">${weekKey}</div>

                  <div class="k">Last capture URL</div>
                  <div class="v">${sourceUrl}</div>
                </div>
              </div>
            </details>

            <details class="pw-details">
              <summary>Saved Weeks (Proof)</summary>
              <div class="pw-details-inner">
                ${renderSavedWeeksTable(saved?.history)}
              </div>
            </details>

            ${warnBlock ? `<div class="pw-warn">${warnBlock}</div>` : ""}

            <div class="pw-btnrow">
              <div class="pw-btn" id="pw-log">Log saved payload</div>
              <div class="pw-btn" id="pw-refresh">Refresh panel</div>
            </div>
          </div>
        </div>
      `;
    }

    // Auto-refresh interval in ms (30 seconds)
    const AUTO_REFRESH_MS = 30_000;
    let autoRefreshTimer = null;

    function refreshPanel() {
      const panel = document.getElementById("perfWidgetPanel");
      if (!panel || panel.style.display !== "block") return;

      // Preserve the RZ note textarea value so typing isn't interrupted
      const noteInput = panel.querySelector("#pw-rz-note");
      const draftNote = noteInput ? noteInput.value : null;

      panel.innerHTML = buildHtml(loadSaved());
      wireButtons(panel);

      // Restore any unsaved draft the user was typing
      if (draftNote !== null) {
        const restored = panel.querySelector("#pw-rz-note");
        if (restored) restored.value = draftNote;
      }
    }

    function startAutoRefresh() {
      if (autoRefreshTimer) return; // already running
      autoRefreshTimer = setInterval(refreshPanel, AUTO_REFRESH_MS);
      log(`Auto-refresh started (every ${AUTO_REFRESH_MS / 1000}s)`);
    }

    function stopAutoRefresh() {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
    }

    function ensureUi() {
      if (!document.getElementById("perfWidgetLauncher")) {
        const btn = document.createElement("div");
        btn.id = "perfWidgetLauncher";
        btn.textContent = "Open Performance Widget";
        document.documentElement.appendChild(btn);

        const panel = document.createElement("div");
        panel.id = "perfWidgetPanel";
        document.documentElement.appendChild(panel);

        btn.addEventListener("click", () => {
          const open = panel.style.display === "block";
          panel.style.display = open ? "none" : "block";

          if (!open) {
            panel.innerHTML = buildHtml(loadSaved());
            wireButtons(panel);
            startAutoRefresh();
          } else {
            stopAutoRefresh();
          }
        });
      }
    }

    function wireButtons(panel) {
      panel.querySelector("#pw-log")?.addEventListener("click", () => {
        log("Saved payload:", loadSaved());
        alert("Saved payload logged to console ✅");
      });

      panel.querySelector("#pw-refresh")?.addEventListener("click", () => {
        panel.innerHTML = buildHtml(loadSaved());
        wireButtons(panel);
      });

      const saved = loadSaved();
      const wk = saved?.weekKey;
      if (!wk) return;

      const input = panel.querySelector("#pw-rz-note");
      panel.querySelector("#pw-save-note")?.addEventListener("click", () => {
        const val = input ? input.value : "";
        setRZNote(wk, val);
        panel.innerHTML = buildHtml(loadSaved());
        wireButtons(panel);
      });

      panel.querySelector("#pw-clear-note")?.addEventListener("click", () => {
        setRZNote(wk, "");
        if (input) input.value = "";
        panel.innerHTML = buildHtml(loadSaved());
        wireButtons(panel);
      });
    }

    ensureUi();
    const obs = new MutationObserver(ensureUi);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ------------------------------
  // BOOT
  // ------------------------------
  const host = location.hostname;
  if (host.includes("tempo")) startTempoCapture();
  if (host.includes("phonetool")) startPhoneToolWidget();

})()
