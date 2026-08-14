/* ============================================================
   Shopping Cost Analyzer
   Parses Apple Notes "Shopping cost week X" + "Category<TAB>amount" lines.
   Pure client-side. No data leaves the browser.
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Theme toggle ---------- */
  (function initTheme() {
    var toggle = document.querySelector('[data-theme-toggle]');
    var root = document.documentElement;
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(dark ? 'dark' : 'light');

    function applyTheme(t) {
      root.setAttribute('data-theme', t);
      if (!toggle) return;
      toggle.setAttribute('aria-label', 'Switch to ' + (t === 'dark' ? 'light' : 'dark') + ' mode');
      toggle.innerHTML = t === 'dark'
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    }
    if (toggle) {
      toggle.addEventListener('click', function () {
        dark = !dark;
        applyTheme(dark ? 'dark' : 'light');
      });
    }
  })();

  /* ---------- Parser ---------- */

  // Normalise a category name: trim, collapse whitespace, lowercase.
  function normalizeCategory(name) {
    return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // Test whether a token looks like a monetary amount.
  // Supports: 120, 117, 18.74, 47.00, .00, 12.5, -5
  function looksLikeAmount(token) {
    return /^-?(\d+(\.\d+)?|\.\d+)$/.test(token);
  }

  // Detect week headers. Tolerant of:
  //   "Shopping cost week 1", "SHOPPING COST week 10",
  //   "Shopping cost wk 3", "Shoppin cost week 5" (typo),
  //   "Shopping COST  week 2" (extra spaces)
  var WEEK_RE = /shoppin(?:g)?\s*cost\s*(?:wk|week)?\s*(\d+)/gi;

  function parseShoppingNotes(input) {
    var text = (input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    var headers = [];
    var match;
    WEEK_RE.lastIndex = 0;
    while ((match = WEEK_RE.exec(text)) !== null) {
      headers.push({ weekNumber: Number(match[1]), index: match.index, headerLen: match[0].length });
    }

    var weeks = [];

    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      var nextIndex = i + 1 < headers.length ? headers[i + 1].index : text.length;
      var block = text.slice(h.index + h.headerLen, nextIndex);

      var lines = block.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

      var rows = [];
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        // Split on any whitespace (tabs or spaces)
        var tokens = line.split(/\s+/);
        if (tokens.length < 1) continue;

        var last = tokens[tokens.length - 1];
        var amount = looksLikeAmount(last) ? Number(last) : null;

        var rawCategory;
        if (amount === null) {
          // No numeric token → whole line is category, amount missing
          rawCategory = line;
        } else {
          // Strip the trailing numeric token from the line to get the category
          var cut = line.lastIndexOf(last);
          rawCategory = line.slice(0, cut).trim();
          // If stripping leaves nothing, the "category" was the number itself — skip
          if (!rawCategory) continue;
        }

        rawCategory = rawCategory.replace(/\s+/g, ' ').trim();
        if (!rawCategory) continue;

        rows.push({
          rawCategory: rawCategory,
          category: normalizeCategory(rawCategory),
          amount: amount,
          missing: amount === null,
        });
      }

      // Totals (missing = 0)
      var total = 0;
      var filledCount = 0;
      for (var k = 0; k < rows.length; k++) {
        if (rows[k].amount !== null) {
          total += rows[k].amount;
          filledCount++;
        }
      }

      // Category totals this week (normalized keys)
      var catTotals = {};
      var displayNames = {};
      for (var m = 0; m < rows.length; m++) {
        var r = rows[m];
        if (r.amount === null) continue;
        catTotals[r.category] = (catTotals[r.category] || 0) + r.amount;
        if (!displayNames[r.category]) displayNames[r.category] = r.rawCategory;
      }

      weeks.push({
        weekNumber: h.weekNumber,
        total: total,
        filledCount: filledCount,
        rows: rows,
        catTotals: catTotals,
        displayNames: displayNames,
      });
    }

    // Sort by week number
    weeks.sort(function (a, b) { return a.weekNumber - b.weekNumber; });

    // Week-over-week deltas
    for (var w = 0; w < weeks.length; w++) {
      weeks[w].delta = w === 0 ? null : weeks[w].total - weeks[w - 1].total;
    }

    return { weeks: weeks };
  }


  /* ---------- Persistent browser history ---------- */

  var STORAGE_KEY = 'shopping-cost-analyzer-history-v1';

  function saveWeeks(weeks) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(weeks));
    } catch (e) {
      console.warn('Could not save shopping history:', e);
    }
  }

  function loadWeeks() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var weeks = JSON.parse(raw);
      if (!Array.isArray(weeks)) return [];
      return weeks.filter(function (w) {
        return w && typeof w.weekNumber === 'number' && Array.isArray(w.rows);
      });
    } catch (e) {
      console.warn('Could not load shopping history:', e);
      return [];
    }
  }

  // A pasted week replaces the same week number, so corrections are easy.
  // New week numbers are appended to the saved history.
  function mergeWeeks(savedWeeks, incomingWeeks) {
    var byWeek = {};
    for (var i = 0; i < savedWeeks.length; i++) {
      byWeek[savedWeeks[i].weekNumber] = savedWeeks[i];
    }
    for (var j = 0; j < incomingWeeks.length; j++) {
      byWeek[incomingWeeks[j].weekNumber] = incomingWeeks[j];
    }

    var merged = Object.keys(byWeek).map(function (key) {
      return byWeek[key];
    });

    merged.sort(function (a, b) { return a.weekNumber - b.weekNumber; });

    for (var w = 0; w < merged.length; w++) {
      merged[w].delta = w === 0 ? null : merged[w].total - merged[w - 1].total;
    }
    return merged;
  }

  function updateSavedState(weeks) {
    var card = document.getElementById('saved-state');
    var count = document.getElementById('saved-count');
    var meta = document.getElementById('saved-meta');
    if (!card || !count || !meta) return;

    if (!weeks.length) {
      card.hidden = true;
      return;
    }

    card.hidden = false;
    count.textContent = weeks.length + ' week' + (weeks.length === 1 ? '' : 's') + ' saved';
    var latest = weeks[weeks.length - 1];
    meta.textContent = 'Stored only in this browser · latest is Week ' + latest.weekNumber;
  }

  function persistAndRender(incoming) {
    var saved = loadWeeks();
    var merged = mergeWeeks(saved, incoming);
    saveWeeks(merged);
    updateSavedState(merged);
    render({ weeks: merged });
    return merged;
  }

  /* ---------- Formatting helpers ---------- */

  function gbp(n) {
    var x = Number(n || 0);
    return '\u00a3' + x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function gbpShort(n) {
    var x = Number(n || 0);
    if (Math.abs(x) >= 1000) {
      return '\u00a3' + (x / 1000).toFixed(1) + 'k';
    }
    return '\u00a3' + x.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function deltaStr(n) {
    if (n === null || n === undefined) return '\u2014';
    var s = (n >= 0 ? '+' : '') + gbp(n);
    return s;
  }

  function pct(part, whole) {
    if (!whole) return '0%';
    return Math.round((part / whole) * 100) + '%';
  }

  /* ---------- Aggregate across weeks ---------- */

  function aggregateCategories(weeks) {
    var totals = {};
    var display = {};
    var weekCount = {};
    for (var i = 0; i < weeks.length; i++) {
      var ct = weeks[i].catTotals;
      var dn = weeks[i].displayNames;
      for (var key in ct) {
        if (!Object.prototype.hasOwnProperty.call(ct, key)) continue;
        totals[key] = (totals[key] || 0) + ct[key];
        weekCount[key] = (weekCount[key] || 0) + 1;
        if (!display[key] && dn[key]) display[key] = dn[key];
      }
    }
    return { totals: totals, display: display, weekCount: weekCount };
  }

  /* ---------- Rendering ---------- */

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderInsights(result, agg) {
    var weeks = result.weeks;
    var grandTotal = 0;
    var highestWeek = null;
    for (var i = 0; i < weeks.length; i++) {
      grandTotal += weeks[i].total;
      if (!highestWeek || weeks[i].total > highestWeek.total) highestWeek = weeks[i];
    }
    var avg = weeks.length ? grandTotal / weeks.length : 0;

    // Top category
    var topCat = null, topAmt = 0;
    for (var key in agg.totals) {
      if (agg.totals[key] > topAmt) { topAmt = agg.totals[key]; topCat = key; }
    }

    // Biggest jump (largest week-over-week increase)
    var biggestJump = null;
    for (var j = 1; j < weeks.length; j++) {
      if (weeks[j].delta !== null && weeks[j].delta > 0) {
        if (!biggestJump || weeks[j].delta > biggestJump.delta) biggestJump = weeks[j];
      }
    }

    document.getElementById('insight-total').textContent = gbp(grandTotal);
    document.getElementById('insight-total-meta').textContent = weeks.length + ' week' + (weeks.length === 1 ? '' : 's');

    document.getElementById('insight-highest').textContent = highestWeek ? gbp(highestWeek.total) : '\u2014';
    document.getElementById('insight-highest-meta').textContent = highestWeek ? 'Week ' + highestWeek.weekNumber : '';

    document.getElementById('insight-avg').textContent = gbp(avg);
    document.getElementById('insight-avg-meta').textContent = 'per week';

    document.getElementById('insight-jump').textContent = biggestJump ? '+' + gbp(biggestJump.delta) : '\u2014';
    document.getElementById('insight-jump-meta').textContent = biggestJump ? 'Week ' + biggestJump.weekNumber + ' vs ' + (biggestJump.weekNumber - 1) : 'no increases';

    document.getElementById('insight-topcat').textContent = topCat ? (agg.display[topCat] || topCat) : '\u2014';
    document.getElementById('insight-topcat-meta').textContent = topCat ? gbp(topAmt) + ' (' + pct(topAmt, grandTotal) + ' of total)' : '';
  }

  function renderWeeklyChart(weeks) {
    var wrap = document.getElementById('weekly-chart');
    wrap.innerHTML = '';

    if (!weeks.length) return;

    // Layout
    var barW = 56;
    var barGap = 24;
    var labelH = 44;
    var axisH = 28;
    var chartH = 220;
    var padL = 56;
    var padR = 16;
    var padT = 16;

    var n = weeks.length;
    var plotW = Math.max(n * (barW + barGap) - barGap, 100);
    var totalW = padL + plotW + padR;
    var totalH = padT + chartH + axisH + labelH;

    var maxVal = 0;
    for (var i = 0; i < weeks.length; i++) maxVal = Math.max(maxVal, weeks[i].total);
    // Round up to a nice number
    var niceMax = niceCeil(maxVal);
    var scale = chartH / niceMax;

    // Collect CSS colors
    var style = getComputedStyle(document.documentElement);
    var cBorder = style.getPropertyValue('--color-border').trim() || '#d8d3c7';
    var cMuted = style.getPropertyValue('--color-text-muted').trim() || '#6b6960';
    var cFaint = style.getPropertyValue('--color-text-faint').trim() || '#a8a59c';
    var cPrimary = style.getPropertyValue('--color-primary').trim() || '#01675a';
    var cPrimarySoft = style.getPropertyValue('--color-primary-soft').trim() || '#d4e8e3';
    var cSurface = style.getPropertyValue('--color-surface').trim() || '#fbfaf7';

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + totalW + ' ' + totalH);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Bar chart of weekly spending');

    // Y-axis gridlines + labels (4 steps)
    var steps = 4;
    for (var s = 0; s <= steps; s++) {
      var val = (niceMax / steps) * s;
      var y = padT + chartH - val * scale;

      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', padL);
      line.setAttribute('y1', y);
      line.setAttribute('x2', padL + plotW);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', cBorder);
      line.setAttribute('stroke-width', s === 0 ? '1.5' : '1');
      line.setAttribute('stroke-dasharray', s === 0 ? '0' : '3 4');
      svg.appendChild(line);

      var lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', padL - 10);
      lbl.setAttribute('y', y + 4);
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('font-size', '11');
      lbl.setAttribute('font-family', 'DM Sans, sans-serif');
      lbl.setAttribute('fill', cMuted);
      lbl.textContent = gbpShort(val);
      svg.appendChild(lbl);
    }

    // Bars
    for (var b = 0; b < weeks.length; b++) {
      var w = weeks[b];
      var barH = w.total * scale;
      var x = padL + b * (barW + barGap);
      var y = padT + chartH - barH;

      // Bar
      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', barW);
      rect.setAttribute('height', Math.max(barH, 0.5));
      rect.setAttribute('rx', '6');
      rect.setAttribute('fill', cPrimary);
      rect.setAttribute('class', 'chart-bar');
      // Hover title
      var title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = 'Week ' + w.weekNumber + ': ' + gbp(w.total) + ' (' + w.filledCount + ' items)';
      rect.appendChild(title);
      svg.appendChild(rect);

      // Value label above bar
      var vlbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      vlbl.setAttribute('x', x + barW / 2);
      vlbl.setAttribute('y', y - 8);
      vlbl.setAttribute('text-anchor', 'middle');
      vlbl.setAttribute('font-size', '12');
      vlbl.setAttribute('font-weight', '600');
      vlbl.setAttribute('font-family', 'DM Sans, sans-serif');
      vlbl.setAttribute('fill', cPrimary);
      vlbl.textContent = gbpShort(w.total);
      svg.appendChild(vlbl);

      // Week label below
      var wlbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      wlbl.setAttribute('x', x + barW / 2);
      wlbl.setAttribute('y', padT + chartH + 22);
      wlbl.setAttribute('text-anchor', 'middle');
      wlbl.setAttribute('font-size', '12');
      wlbl.setAttribute('font-weight', '500');
      wlbl.setAttribute('font-family', 'DM Sans, sans-serif');
      wlbl.setAttribute('fill', cMuted);
      wlbl.textContent = 'W' + w.weekNumber;
      svg.appendChild(wlbl);
    }

    wrap.appendChild(svg);
  }

  function niceCeil(v) {
    if (v <= 0) return 10;
    var pow = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / pow;
    var nice;
    if (n <= 1) nice = 1;
    else if (n <= 2) nice = 2;
    else if (n <= 5) nice = 5;
    else nice = 10;
    return nice * pow;
  }

  function renderWeeklyTable(weeks) {
    var tbody = document.querySelector('#weekly-table tbody');
    tbody.innerHTML = '';
    for (var i = 0; i < weeks.length; i++) {
      var w = weeks[i];
      var tr = document.createElement('tr');

      tr.appendChild(el('td', 'week-cell', 'Week ' + w.weekNumber));
      tr.appendChild(el('td', 'num', gbp(w.total)));

      var dtd = el('td', 'num');
      if (w.delta === null) {
        dtd.textContent = '\u2014';
        dtd.className = 'num delta-zero';
      } else if (w.delta > 0) {
        dtd.textContent = deltaStr(w.delta);
        dtd.className = 'num delta-pos';
      } else if (w.delta < 0) {
        dtd.textContent = deltaStr(w.delta);
        dtd.className = 'num delta-neg';
      } else {
        dtd.textContent = '\u00b10.00';
        dtd.className = 'num delta-zero';
      }
      tr.appendChild(dtd);

      tr.appendChild(el('td', 'num', String(w.filledCount)));
      tbody.appendChild(tr);
    }
  }

  function renderCategoryBars(agg, grandTotal) {
    var wrap = document.getElementById('cat-bars');
    wrap.innerHTML = '';

    var entries = Object.keys(agg.totals).map(function (k) {
      return { key: k, amount: agg.totals[k], name: agg.display[k] || k, weeks: agg.weekCount[k] || 0 };
    });
    entries.sort(function (a, b) { return b.amount - a.amount; });
    var top = entries.slice(0, 10);

    if (!top.length) {
      wrap.appendChild(el('div', '', 'No numeric category rows found.'));
      return;
    }

    var maxAmt = top[0].amount;

    // Palette cycle for variety
    var palette = [
      'var(--color-primary)',
      'var(--color-accent)',
      'var(--color-positive)',
      'var(--color-blue, #006494)',
      'var(--color-purple, #7a39bb)',
      'var(--color-gold, #d19900)',
      'var(--color-orange, #da7101)',
    ];

    for (var i = 0; i < top.length; i++) {
      var c = top[i];
      var row = document.createElement('div');
      row.className = 'cat-bar-row';

      var label = el('div', 'cat-bar-label', c.name);
      var amt = el('div', 'cat-bar-amt', gbp(c.amount) + '  \u00b7 ' + pct(c.amount, grandTotal));

      var track = document.createElement('div');
      track.className = 'cat-bar-track';
      var fill = document.createElement('div');
      fill.className = 'cat-bar-fill';
      fill.style.width = '0%';
      fill.style.background = palette[i % palette.length];
      track.appendChild(fill);

      row.appendChild(label);
      row.appendChild(amt);
      row.appendChild(track);
      wrap.appendChild(row);

      // Animate fill
      requestAnimationFrame(function (f, w) {
        f.style.width = w + '%';
      }.bind(null, fill, (c.amount / maxAmt) * 100));
    }
  }

  function renderBreakdownTable(weeks, agg) {
    var head = document.getElementById('breakdown-head');
    var body = document.getElementById('breakdown-body');
    head.innerHTML = '';
    body.innerHTML = '';

    // Build the union of categories across all weeks, sorted by total spend desc
    var allCats = Object.keys(agg.totals)
      .map(function (k) { return { key: k, name: agg.display[k] || k, total: agg.totals[k] }; })
      .sort(function (a, b) { return b.total - a.total; });

    // Header row
    head.appendChild(el('th', '', 'Category'));
    for (var i = 0; i < weeks.length; i++) {
      head.appendChild(el('th', 'num', 'W' + weeks[i].weekNumber));
    }
    head.appendChild(el('th', 'num', 'Total'));

    // Body rows
    for (var r = 0; r < allCats.length; r++) {
      var cat = allCats[r];
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'breakdown-cat', cat.name));

      for (var w = 0; w < weeks.length; w++) {
        var amt = weeks[w].catTotals[cat.key];
        if (amt === undefined) {
          var td = el('td', 'breakdown-blank', '\u2014');
          tr.appendChild(td);
        } else {
          var share = weeks[w].total ? pct(amt, weeks[w].total) : '0%';
          var cell = el('td', 'num', gbp(amt) + ' \u00b7 ' + share);
          cell.title = agg.display[cat.key] + ' / Week ' + weeks[w].weekNumber + ': ' + gbp(amt) + ' (' + share + ' of week)';
          tr.appendChild(cell);
        }
      }
      tr.appendChild(el('td', 'num', gbp(cat.total)));
      body.appendChild(tr);
    }

    // Totals row
    var totalRow = document.createElement('tr');
    totalRow.style.fontWeight = '600';
    totalRow.style.borderTop = '2px solid var(--color-divider)';
    totalRow.appendChild(el('td', '', 'Total'));
    for (var t = 0; t < weeks.length; t++) {
      totalRow.appendChild(el('td', 'num', gbp(weeks[t].total)));
    }
    var grandTotal = 0;
    for (var g = 0; g < weeks.length; g++) grandTotal += weeks[g].total;
    totalRow.appendChild(el('td', 'num', gbp(grandTotal)));
    body.appendChild(totalRow);

    document.getElementById('breakdown-note').textContent = allCats.length + ' categories across ' + weeks.length + ' week' + (weeks.length === 1 ? '' : 's');
  }

  /* ---------- Category movers ---------- */

  function renderMovers(weeks, agg) {
    var grid = document.getElementById('movers-grid');
    grid.innerHTML = '';

    if (weeks.length < 2) {
      grid.appendChild(el('div', 'mover-empty', 'Need at least 2 weeks to show week-over-week movers.'));
      document.getElementById('movers-note').textContent = '';
      return;
    }

    // Compare the last two weeks
    var prev = weeks[weeks.length - 2];
    var curr = weeks[weeks.length - 1];
    document.getElementById('movers-note').textContent = 'Week ' + curr.weekNumber + ' vs Week ' + prev.weekNumber;

    // Compute per-category deltas
    var movers = [];
    for (var key in agg.totals) {
      if (!Object.prototype.hasOwnProperty.call(agg.totals, key)) continue;
      var prevAmt = prev.catTotals[key] || 0;
      var currAmt = curr.catTotals[key] || 0;
      var delta = currAmt - prevAmt;
      if (delta !== 0) {
        movers.push({ key: key, name: agg.display[key] || key, delta: delta, prevAmt: prevAmt, currAmt: currAmt });
      }
    }

    // Sort: increases first (by delta desc), then decreases (by delta asc)
    movers.sort(function (a, b) {
      if (b.delta > 0 && a.delta > 0) return b.delta - a.delta;
      if (b.delta < 0 && a.delta < 0) return a.delta - b.delta; // smaller negative first
      return b.delta - a.delta;
    });

    var increases = movers.filter(function (m) { return m.delta > 0; }).slice(0, 5);
    var decreases = movers.filter(function (m) { return m.delta < 0; }).slice(0, 5);

    // Two columns: increases and decreases
    var incCol = document.createElement('div');
    incCol.appendChild(el('div', 'movers-col-title', '\u2191 Increases'));
    var incList = el('div', 'movers-list');
    if (!increases.length) {
      incList.appendChild(el('div', 'mover-empty', 'No increases this week.'));
    } else {
      for (var i = 0; i < increases.length; i++) {
        incList.appendChild(moverRow(increases[i]));
      }
    }
    incCol.appendChild(incList);
    grid.appendChild(incCol);

    var decCol = document.createElement('div');
    decCol.appendChild(el('div', 'movers-col-title', '\u2193 Decreases'));
    var decList = el('div', 'movers-list');
    if (!decreases.length) {
      decList.appendChild(el('div', 'mover-empty', 'No decreases this week.'));
    } else {
      for (var d = 0; d < decreases.length; d++) {
        decList.appendChild(moverRow(decreases[d]));
      }
    }
    decCol.appendChild(decList);
    grid.appendChild(decCol);
  }

  function moverRow(m) {
    var row = el('div', 'mover-row');
    row.appendChild(el('span', 'mover-label', m.name));
    var deltaEl = el('span', 'mover-delta ' + (m.delta > 0 ? 'pos' : 'neg'), deltaStr(m.delta));
    row.appendChild(deltaEl);
    return row;
  }

  /* ---------- CSV Export ---------- */

  function exportCSV(result, agg) {
    var weeks = result.weeks;
    var allCats = Object.keys(agg.totals)
      .map(function (k) { return { key: k, name: agg.display[k] || k, total: agg.totals[k] }; })
      .sort(function (a, b) { return b.total - a.total; });

    var rows = [];
    // Header
    var header = ['Category'];
    for (var i = 0; i < weeks.length; i++) header.push('Week ' + weeks[i].weekNumber);
    header.push('Total');
    rows.push(header);

    // Data rows
    for (var r = 0; r < allCats.length; r++) {
      var cat = allCats[r];
      var row = [cat.name];
      for (var w = 0; w < weeks.length; w++) {
        var amt = weeks[w].catTotals[cat.key];
        row.push(amt === undefined ? '' : amt.toFixed(2));
      }
      row.push(cat.total.toFixed(2));
      rows.push(row);
    }

    // Totals row
    var totalRow = ['Total'];
    var grandTotal = 0;
    for (var t = 0; t < weeks.length; t++) {
      totalRow.push(weeks[t].total.toFixed(2));
      grandTotal += weeks[t].total;
    }
    totalRow.push(grandTotal.toFixed(2));
    rows.push(totalRow);

    // Convert to CSV string
    var csv = rows.map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\n');

    // Download
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'shopping-cost-analysis.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvCell(val) {
    var s = String(val);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /* ---------- Main render ---------- */

  function render(result) {
    var weeks = result.weeks;
    var agg = aggregateCategories(weeks);

    if (!weeks.length) {
      document.getElementById('results').hidden = true;
      document.getElementById('empty-state').hidden = false;
      document.getElementById('parse-hint').textContent = 'No weeks found. Make sure each week starts with "Shopping cost week X".';
      return;
    }

    document.getElementById('results').hidden = false;
    document.getElementById('empty-state').hidden = true;
    document.getElementById('parse-hint').textContent = 'Parsed ' + weeks.length + ' week' + (weeks.length === 1 ? '' : 's') + '. Categories merged case-insensitively.';

    renderInsights(result, agg);
    renderWeeklyChart(weeks);
    renderWeeklyTable(weeks);

    var grandTotal = 0;
    for (var i = 0; i < weeks.length; i++) grandTotal += weeks[i].total;
    renderCategoryBars(agg, grandTotal);
    renderMovers(weeks, agg);
    renderBreakdownTable(weeks, agg);

    // Wire CSV button
    var csvBtn = document.getElementById('btn-csv');
    csvBtn.onclick = function () { exportCSV(result, agg); };
  }

  /* ---------- Sample data ---------- */

  var SAMPLE = [
    'Shopping cost week 1',
    'Food\t120',
    'Trains\t117',
    'Coffee\t18.74',
    'Drinks',
    'Petrol\t45',
    'Haircut\t24',
    '',
    'Shopping cost week 2',
    'Food\t135',
    'Trains\t92',
    'Coffee\t22',
    'Petrol\t52',
    'Car Repair\t180',
    '',
    'Shopping cost week 3',
    'food\t128',
    'Trains\t105',
    'coffee\t15.50',
    'Drinks\t38',
    'Petrol\t48',
    'car repair\t47.00',
    'Birthday gift\t35',
    '',
    'Shopping cost week 4',
    'Food\t142',
    'Coffee\t19',
    'Petrol\t55',
    'Haircut\t24',
    'Eating out\t67',
    '',
    'Shoppin cost week 5',
    'Food\t130',
    'Trains\t88',
    'Coffee\t21',
    'Petrol\t50',
    'Drinks\t24',
    'Clothes\t65',
  ].join('\n');


  /* ---------- App navigation + history page ---------- */

  function currentWeeks() { return loadWeeks().slice().sort(function(a,b){ return a.weekNumber-b.weekNumber; }); }

  function showPage(name) {
    var pages = { dashboard: 'page-dashboard', add: 'page-add', history: 'page-history' };
    Object.keys(pages).forEach(function(k){
      var el = document.getElementById(pages[k]);
      if (el) el.hidden = k !== name;
    });
    document.querySelectorAll('[data-nav]').forEach(function(a){
      a.classList.toggle('active', a.getAttribute('data-nav') === name);
    });
    if (name === 'history') renderHistory();
    if (name === 'dashboard') {
      var saved = currentWeeks();
      updateSavedState(saved);
      render({weeks:saved});
    }
  }

  function renderHistory() {
    var list = document.getElementById('history-list');
    var summary = document.getElementById('history-summary');
    var search = (document.getElementById('history-search').value || '').trim().toLowerCase();
    var sort = document.getElementById('history-sort').value;
    var weeks = currentWeeks();
    var filtered = weeks.filter(function(w){
      if (!search) return true;
      if (String(w.weekNumber).indexOf(search) !== -1) return true;
      return (w.rows || []).some(function(r){ return String(r.rawCategory || r.category || '').toLowerCase().indexOf(search) !== -1; });
    });
    if (sort === 'week-desc') filtered.sort(function(a,b){return b.weekNumber-a.weekNumber;});
    else if (sort === 'total-desc') filtered.sort(function(a,b){return b.total-a.total;});
    else if (sort === 'total-asc') filtered.sort(function(a,b){return a.total-b.total;});
    else filtered.sort(function(a,b){return a.weekNumber-b.weekNumber;});

    summary.textContent = weeks.length + ' saved week' + (weeks.length === 1 ? '' : 's') + ' · ' + filtered.length + ' shown. Tap a week to edit or inspect its rows.';
    list.innerHTML = '';
    if (!filtered.length) {
      list.appendChild(el('div','history-empty', weeks.length ? 'No weeks match your search.' : 'No weeks saved yet.'));
      return;
    }
    filtered.forEach(function(w){
      var card = el('article','history-item');
      var top = el('div','history-item-top');
      var title = el('div','history-week','Week ' + w.weekNumber);
      var total = el('div','history-total',gbp(w.total));
      top.appendChild(title); top.appendChild(total); card.appendChild(top);
      var meta = el('div','history-meta',(w.filledCount || 0) + ' priced items · ' + Object.keys(w.catTotals || {}).length + ' categories');
      card.appendChild(meta);
      var cats = Object.keys(w.catTotals || {}).map(function(k){ return {name:(w.displayNames && w.displayNames[k]) || k, amount:w.catTotals[k]}; }).sort(function(a,b){return b.amount-a.amount;}).slice(0,6);
      if (cats.length) {
        var catLine = el('div','history-cats');
        cats.forEach(function(c){ catLine.appendChild(el('span','history-chip',c.name + ' ' + gbp(c.amount))); });
        card.appendChild(catLine);
      }
      var actions = el('div','history-actions');
      var edit = el('button','btn btn-ghost btn-sm','Edit / replace');
      edit.addEventListener('click', function(){
        document.getElementById('notes-input').value = ['Shopping cost week ' + w.weekNumber].concat((w.rows || []).map(function(r){ return r.amount === null ? r.rawCategory : r.rawCategory + '\t' + r.amount; })).join('\n');
        location.hash = '#add';
        setTimeout(function(){ document.getElementById('notes-input').focus(); }, 50);
      });
      var del = el('button','btn btn-ghost btn-sm','Delete');
      del.addEventListener('click', function(){
        if (!confirm('Delete Week ' + w.weekNumber + '?')) return;
        var remaining = currentWeeks().filter(function(x){ return x.weekNumber !== w.weekNumber; });
        saveWeeks(remaining); renderHistory();
        if (location.hash === '#dashboard') render({weeks:remaining});
      });
      actions.appendChild(edit); actions.appendChild(del); card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function initNavigation() {
    document.querySelectorAll('[data-nav]').forEach(function(a){
      a.addEventListener('click', function(){
        var target = a.getAttribute('data-nav');
        if (location.hash !== '#' + target) location.hash = '#' + target;
        else showPage(target);
      });
    });
    window.addEventListener('hashchange', function(){
      var target = (location.hash || '#dashboard').slice(1);
      showPage(['dashboard','add','history'].indexOf(target) >= 0 ? target : 'dashboard');
    });
    var initial = (location.hash || '#dashboard').slice(1);
    showPage(['dashboard','add','history'].indexOf(initial) >= 0 ? initial : 'dashboard');
    document.getElementById('history-search').addEventListener('input', renderHistory);
    document.getElementById('history-sort').addEventListener('change', renderHistory);
    document.getElementById('btn-history-analyze').addEventListener('click', function(){ location.hash='#dashboard'; });
  }

  /* ---------- Wire up ---------- */

  var input = document.getElementById('notes-input');
  var parseBtn = document.getElementById('btn-parse');
  var sampleBtn = document.getElementById('btn-sample');
  var clearBtn = document.getElementById('btn-clear');
  var resetHistoryBtn = document.getElementById('btn-reset-history');

  parseBtn.addEventListener('click', function () {
    var text = input.value;
    if (!text.trim()) {
      document.getElementById('parse-hint').textContent = 'Paste some text first, or click Try sample.';
      return;
    }

    var result = parseShoppingNotes(text);
    if (!result.weeks.length) {
      render(result);
      return;
    }

    var merged = persistAndRender(result.weeks);
    document.getElementById('parse-hint').textContent =
      'Saved ' + result.weeks.length + ' pasted week' +
      (result.weeks.length === 1 ? '' : 's') + '. History now contains ' + merged.length + ' week' +
      (merged.length === 1 ? '' : 's') + '.';
  });

  sampleBtn.addEventListener('click', function () {
    input.value = SAMPLE;
    var result = parseShoppingNotes(SAMPLE);
    render(result);
  });

  clearBtn.addEventListener('click', function () {
    input.value = '';
    document.getElementById('parse-hint').textContent = 'Input cleared. Your saved history is still here.';
    var saved = loadWeeks();
    if (saved.length) {
      updateSavedState(saved);
      render({ weeks: saved });
    } else {
      document.getElementById('results').hidden = true;
      document.getElementById('empty-state').hidden = false;
    }
  });

  resetHistoryBtn.addEventListener('click', function () {
    if (!confirm('Delete all saved shopping history from this browser? This cannot be undone.')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    input.value = '';
    updateSavedState([]);
    document.getElementById('results').hidden = true;
    document.getElementById('empty-state').hidden = false;
    document.getElementById('parse-hint').textContent = 'Saved history deleted. Paste a week to start again.';
  });

  // Restore saved history automatically when the app opens.
  var savedOnLoad = loadWeeks();
  updateSavedState(savedOnLoad);
  if (savedOnLoad.length) {
    render({ weeks: savedOnLoad });
    document.getElementById('parse-hint').textContent =
      'Loaded ' + savedOnLoad.length + ' saved week' + (savedOnLoad.length === 1 ? '' : 's') +
      '. Paste another week to add it, or paste an existing week number to replace it.';
  }
  initNavigation();

  // Allow Ctrl/Cmd+Enter to parse
  input.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      parseBtn.click();
    }
  });

})();
