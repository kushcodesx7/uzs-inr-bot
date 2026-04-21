/* UZS → INR dashboard · ECharts + vanilla JS */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const INR = (n, d = 0) =>
  n == null || Number.isNaN(n)
    ? '—'
    : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

const PCT = (n, d = 2) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`);

const tsOf = (r) => new Date(`${r.date}T${r.time}`).getTime();

/* ---------------- Theme ---------------- */
const themeBtn = $('#theme-toggle');
const savedTheme = localStorage.getItem('theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  Object.values(charts).forEach((c) => c && c.setOption(buildTheme()));
  redrawAll();
});

const themeOf = () => document.documentElement.getAttribute('data-theme') || 'dark';
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function buildTheme() {
  return {
    textStyle: { color: cssVar('--fg') },
    backgroundColor: 'transparent',
  };
}

/* ---------------- Animated counter ---------------- */
function animateCounter(el, target, duration = 1200) {
  const start = parseFloat(el.dataset.target || '0');
  el.dataset.target = target;
  const startTime = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  function tick(now) {
    const p = Math.min(1, (now - startTime) / duration);
    const val = start + (target - start) * ease(p);
    el.textContent = Math.round(val).toLocaleString('en-IN');
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = Math.round(target).toLocaleString('en-IN');
  }
  requestAnimationFrame(tick);
}

/* ---------------- Charts registry ---------------- */
const charts = {};
let fullHistory = [];
let currentPayload = null;
let activeRange = '7d';

function gridTheme() {
  const isDark = themeOf() === 'dark';
  return {
    grid: {
      axis: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.08)',
      text: cssVar('--fg-dim'),
    },
    tooltip: {
      bg: isDark ? 'rgba(20,25,38,0.96)' : 'rgba(255,255,255,0.98)',
      border: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.12)',
      text: cssVar('--fg'),
    },
  };
}

/* ---------------- Sparkline ---------------- */
function renderSparkline() {
  const el = $('#sparkline');
  if (!charts.spark) charts.spark = echarts.init(el, null, { renderer: 'canvas' });
  const horizon = 7 * 24 * 3600 * 1000;
  const cutoff = Date.now() - horizon;
  const data = fullHistory.filter((r) => tsOf(r) >= cutoff);
  const points = data.map((r) => [tsOf(r), r.inr]);
  const color = cssVar('--accent-2') || '#22d3ee';
  charts.spark.setOption({
    grid: { left: 0, right: 0, top: 5, bottom: 0 },
    xAxis: { type: 'time', show: false },
    yAxis: { type: 'value', show: false, scale: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: gridTheme().tooltip.bg,
      borderColor: gridTheme().tooltip.border,
      textStyle: { color: gridTheme().tooltip.text, fontSize: 12 },
      formatter: (p) => {
        const d = new Date(p[0].value[0]);
        return `<b>${INR(p[0].value[1])}</b><br/><span style="opacity:.7">${d.toLocaleString()}</span>`;
      },
    },
    series: [
      {
        type: 'line',
        data: points,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(34,211,238,0.3)' },
              { offset: 1, color: 'rgba(34,211,238,0)' },
            ],
          },
        },
        animationDuration: 1100,
        animationEasing: 'cubicOut',
      },
    ],
  });
}

/* ---------------- Main chart (line + MA + bands) ---------------- */
function filterByRange(range) {
  const now = Date.now();
  const map = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, all: Infinity };
  const cutoff = map[range] * 3600 * 1000;
  if (!isFinite(cutoff)) return fullHistory.slice();
  return fullHistory.filter((r) => now - tsOf(r) <= cutoff);
}

function movingAverage(values, win) {
  return values.map((_, i) => {
    if (i < win - 1) return null;
    const slice = values.slice(i - win + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

function bollinger(values, win, mult = 2) {
  const ma = movingAverage(values, win);
  const upper = [], lower = [];
  values.forEach((_, i) => {
    if (ma[i] == null) { upper.push(null); lower.push(null); return; }
    const slice = values.slice(i - win + 1, i + 1);
    const mean = ma[i];
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    const sd = Math.sqrt(variance);
    upper.push(mean + mult * sd);
    lower.push(mean - mult * sd);
  });
  return { ma, upper, lower };
}

function renderMainChart() {
  const el = $('#main-chart');
  if (!charts.main) charts.main = echarts.init(el, null, { renderer: 'canvas' });

  const data = filterByRange(activeRange);
  if (!data.length) {
    charts.main.clear();
    return;
  }
  const times = data.map((r) => tsOf(r));
  const inrs = data.map((r) => r.inr);
  const win = Math.max(2, Math.min(24, Math.floor(data.length / 6) || 2));
  const { ma, upper, lower } = bollinger(inrs, win);

  const markers = data.map((r, i) => {
    if (r.direction === 'UP') return { value: [times[i], inrs[i]], itemStyle: { color: cssVar('--green') } };
    if (r.direction === 'DOWN') return { value: [times[i], inrs[i]], itemStyle: { color: cssVar('--red') } };
    return null;
  }).filter(Boolean);

  const accent = cssVar('--accent');
  const gt = gridTheme();

  charts.main.setOption({
    animationDuration: 900,
    animationEasing: 'cubicOut',
    grid: { left: 60, right: 20, top: 30, bottom: 80 },
    legend: {
      top: 0, right: 10,
      textStyle: { color: cssVar('--fg-dim'), fontSize: 12 },
      icon: 'roundRect',
      itemWidth: 12, itemHeight: 4,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { backgroundColor: accent } },
      backgroundColor: gt.tooltip.bg,
      borderColor: gt.tooltip.border,
      textStyle: { color: gt.tooltip.text },
      formatter: (params) => {
        const date = new Date(params[0].value[0]);
        const rows = params
          .filter((p) => p.value[1] != null)
          .map((p) => `<div style="display:flex;justify-content:space-between;gap:18px"><span style="opacity:.75">${p.marker}${p.seriesName}</span><b>${INR(p.value[1], 2)}</b></div>`)
          .join('');
        return `<div style="font-weight:600;margin-bottom:6px">${date.toLocaleString()}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: gt.grid.axis } },
      axisLabel: { color: gt.grid.text, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true,
      axisLine: { show: false },
      axisLabel: { color: gt.grid.text, formatter: (v) => INR(v) },
      splitLine: { lineStyle: { color: gt.grid.axis, type: 'dashed' } },
    },
    dataZoom: [
      { type: 'inside', start: 0, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true },
      {
        type: 'slider', start: 0, end: 100, height: 32, bottom: 16,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        fillerColor: 'rgba(124,92,255,0.15)',
        handleStyle: { color: accent, borderColor: accent },
        dataBackground: {
          lineStyle: { color: accent, opacity: 0.5 },
          areaStyle: { color: accent, opacity: 0.15 },
        },
        textStyle: { color: gt.grid.text },
      },
    ],
    series: [
      {
        name: 'Upper ±2σ', type: 'line',
        data: times.map((t, i) => [t, upper[i]]),
        lineStyle: { opacity: 0 }, symbol: 'none',
        stack: 'band', silent: true, z: 1,
      },
      {
        name: 'Lower ±2σ', type: 'line',
        data: times.map((t, i) => [t, lower[i] != null ? upper[i] - lower[i] : null]),
        lineStyle: { opacity: 0 }, symbol: 'none',
        stack: 'band', silent: true, z: 1,
        areaStyle: { color: 'rgba(124,92,255,0.08)' },
      },
      {
        name: `MA (${win})`, type: 'line',
        data: times.map((t, i) => [t, ma[i]]),
        smooth: true, showSymbol: false,
        lineStyle: { color: cssVar('--yellow'), width: 1.5, type: 'dashed' },
        z: 2,
      },
      {
        name: 'INR value', type: 'line',
        data: times.map((t, i) => [t, inrs[i]]),
        smooth: 0.3,
        showSymbol: false,
        lineStyle: { color: accent, width: 2.5 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(124,92,255,0.35)' },
              { offset: 1, color: 'rgba(124,92,255,0)' },
            ],
          },
        },
        emphasis: { focus: 'series', lineStyle: { width: 3 } },
        markPoint: markers.length
          ? {
              symbol: 'circle', symbolSize: 8,
              data: markers,
              label: { show: false },
            }
          : undefined,
        z: 3,
      },
    ],
  });
}

/* ---------------- Delta bars ---------------- */
function renderDelta() {
  const el = $('#delta-chart');
  if (!charts.delta) charts.delta = echarts.init(el, null, { renderer: 'canvas' });
  const data = fullHistory.slice(-40);
  const times = data.map((r) => tsOf(r));
  const deltas = data.map((r) => r.change || 0);
  const gt = gridTheme();
  const threshold = currentPayload?.alert_threshold_inr || 500;

  charts.delta.setOption({
    animationDuration: 900,
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: gt.tooltip.bg,
      borderColor: gt.tooltip.border,
      textStyle: { color: gt.tooltip.text },
      formatter: (p) => {
        const d = new Date(p[0].value[0]);
        const v = p[0].value[1];
        return `<b style="color:${v >= 0 ? cssVar('--green') : cssVar('--red')}">${v >= 0 ? '+' : ''}${INR(v, 2)}</b><br/><span style="opacity:.7">${d.toLocaleString()}</span>`;
      },
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: gt.grid.axis } },
      axisLabel: { color: gt.grid.text, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisLabel: { color: gt.grid.text, formatter: (v) => (v >= 0 ? '+' : '') + INR(v) },
      splitLine: { lineStyle: { color: gt.grid.axis, type: 'dashed' } },
    },
    series: [
      {
        type: 'bar',
        data: times.map((t, i) => ({
          value: [t, deltas[i]],
          itemStyle: {
            color: deltas[i] > 0 ? cssVar('--green') : deltas[i] < 0 ? cssVar('--red') : cssVar('--muted'),
            borderRadius: [3, 3, 0, 0],
            opacity: Math.abs(deltas[i]) > threshold ? 1 : 0.55,
          },
        })),
        barMaxWidth: 12,
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: cssVar('--yellow'), opacity: 0.4, type: 'dashed' },
          label: { color: cssVar('--yellow'), formatter: '±₹' + threshold.toLocaleString('en-IN') },
          data: [[{ yAxis: threshold }, { yAxis: threshold }], [{ yAxis: -threshold }, { yAxis: -threshold }]],
        },
      },
    ],
  });
}

/* ---------------- Z-score gauge ---------------- */
function renderGauge() {
  const el = $('#gauge-chart');
  if (!charts.gauge) charts.gauge = echarts.init(el, null, { renderer: 'canvas' });
  const z = currentPayload?.analytics?.zscore;
  const displayVal = z == null ? 0 : Math.max(-3, Math.min(3, z));
  const color = z == null
    ? cssVar('--muted')
    : Math.abs(z) >= 2
    ? cssVar('--red')
    : Math.abs(z) >= 1
    ? cssVar('--yellow')
    : cssVar('--green');

  charts.gauge.setOption({
    animationDuration: 1200,
    series: [
      {
        type: 'gauge',
        min: -3, max: 3,
        startAngle: 210, endAngle: -30,
        radius: '95%',
        progress: { show: true, width: 16, itemStyle: { color } },
        axisLine: {
          lineStyle: {
            width: 16,
            color: [
              [0.33, 'rgba(248,113,113,0.25)'],
              [0.66, 'rgba(251,191,36,0.25)'],
              [1, 'rgba(52,211,153,0.25)'],
            ],
          },
        },
        axisTick: { show: false },
        splitLine: { length: 10, lineStyle: { color: cssVar('--muted'), width: 1 } },
        axisLabel: { color: cssVar('--muted'), distance: 22, fontSize: 10 },
        pointer: { show: true, length: '65%', width: 4, itemStyle: { color } },
        anchor: { show: true, size: 14, itemStyle: { color, borderWidth: 2, borderColor: cssVar('--bg') } },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '40%'],
          fontSize: 32,
          fontWeight: 700,
          color: cssVar('--fg'),
          formatter: (v) => (z == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}σ`),
        },
        title: { offsetCenter: [0, '72%'], color: cssVar('--muted'), fontSize: 11 },
        data: [{ value: displayVal, name: z == null ? 'not enough data yet' : interpretZ(z) }],
      },
    ],
  });
}

function interpretZ(z) {
  if (z >= 2) return 'well above average';
  if (z >= 1) return 'above average';
  if (z <= -2) return 'well below average';
  if (z <= -1) return 'below average';
  return 'near average';
}

/* ---------------- Heatmap (day-of-week × hour) ---------------- */
function renderHeatmap() {
  const el = $('#heatmap-chart');
  if (!charts.heatmap) charts.heatmap = echarts.init(el, null, { renderer: 'canvas' });

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = {};
  fullHistory.forEach((r) => {
    const d = new Date(`${r.date}T${r.time}`);
    const key = `${d.getDay()}-${d.getHours()}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(Math.abs(r.change || 0));
  });
  const data = [];
  let maxVal = 0;
  for (let h = 0; h < 24; h++) {
    for (let dow = 0; dow < 7; dow++) {
      const arr = buckets[`${dow}-${h}`] || [];
      const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      if (avg > maxVal) maxVal = avg;
      data.push([h, dow, arr.length ? +avg.toFixed(2) : null]);
    }
  }
  const gt = gridTheme();

  charts.heatmap.setOption({
    animationDuration: 800,
    tooltip: {
      backgroundColor: gt.tooltip.bg,
      borderColor: gt.tooltip.border,
      textStyle: { color: gt.tooltip.text },
      formatter: (p) => {
        const [h, d, v] = p.value;
        if (v == null) return `${days[d]} · ${h}:00<br/><span style="opacity:.6">no data</span>`;
        return `<b>${days[d]} · ${h}:00</b><br/>Avg |Δ|: <b>${INR(v, 2)}</b>`;
      },
    },
    grid: { left: 45, right: 20, top: 20, bottom: 60 },
    xAxis: {
      type: 'category',
      data: Array.from({ length: 24 }, (_, i) => i + ':00'),
      splitArea: { show: true },
      axisLabel: { color: gt.grid.text, fontSize: 10 },
    },
    yAxis: {
      type: 'category',
      data: days,
      splitArea: { show: true },
      axisLabel: { color: gt.grid.text },
    },
    visualMap: {
      min: 0,
      max: maxVal || 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center', bottom: 5,
      itemWidth: 12, itemHeight: 160,
      textStyle: { color: gt.grid.text, fontSize: 10 },
      inRange: { color: ['rgba(124,92,255,0.0)', 'rgba(124,92,255,0.3)', '#7c5cff', '#f472b6'] },
    },
    series: [
      {
        name: 'Avg |Δ INR|',
        type: 'heatmap',
        data,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(124,92,255,0.6)' } },
      },
    ],
  });
}

/* ---------------- Stats cards ---------------- */
function statCard(label, value, sub = '', chip = '') {
  return `<div class="stat">
    <div class="stat-label">${label}${chip}</div>
    <div class="stat-value">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

function renderStats() {
  const a = currentPayload?.analytics || {};
  const hist = fullHistory;
  const cur = a.current_inr ?? hist.at(-1)?.inr;

  let chip24 = '';
  if (hist.length >= 2) {
    const prev24 = hist.find((r) => Date.now() - tsOf(r) <= 24 * 3600 * 1000);
    if (prev24) {
      const pct = ((cur - prev24.inr) / prev24.inr) * 100;
      chip24 = `<span class="chip ${pct >= 0 ? 'up' : 'down'}">${PCT(pct)}</span>`;
    }
  }

  const trend = a.slope_7d == null ? '—' : a.slope_7d > 0 ? '↗ Rising' : a.slope_7d < 0 ? '↘ Falling' : '→ Flat';
  const trendColor = a.slope_7d == null ? '' : a.slope_7d > 0 ? 'color:var(--green)' : a.slope_7d < 0 ? 'color:var(--red)' : '';

  const pctHigh = a.pct_from_high_30d == null ? '' : `${PCT(a.pct_from_high_30d)} vs high`;
  const pctLow = a.pct_from_low_30d == null ? '' : `${PCT(a.pct_from_low_30d)} vs low`;
  const hiLoSub = [pctHigh, pctLow].filter(Boolean).join(' · ') || 'Need 30d of data';

  const rateDisp = currentPayload?.current_rate
    ? `1 UZS = ${currentPayload.current_rate.toExponential(4)} INR`
    : '—';

  $('#stats').innerHTML = [
    statCard('Current value', INR(cur), rateDisp, chip24),
    statCard('24h avg', INR(a.ma_24h), `Last ${Math.min(6, hist.length)} checks`),
    statCard('7d avg', INR(a.ma_7d), 'Last ~42 checks'),
    statCard('30d avg', INR(a.ma_30d), a.ma_30d ? '' : 'building up…'),
    statCard('Trend 7d', `<span style="${trendColor}">${trend}</span>`, 'Linear regression'),
    statCard('30d high / low', `${INR(a.high_30d)} <span style="opacity:.4">/</span> ${INR(a.low_30d)}`, hiLoSub),
    statCard('Data points', `${hist.length}`, hist.length >= 42 ? 'signals stable' : 'signals warming up'),
    statCard('Alert threshold', INR(currentPayload?.alert_threshold_inr), 'Per-check Δ to fire Telegram'),
  ].join('');
}

/* ---------------- Hero ---------------- */
function renderHero() {
  const last = fullHistory.at(-1);
  if (!last) return;
  const cur = last.inr;
  animateCounter($('#hero-inr'), cur);

  const dir = last.direction || 'FLAT';
  const dirEl = $('#hero-direction');
  dirEl.textContent = dir;
  dirEl.className = 'tag ' + dir.toLowerCase();

  const deltaEl = $('#hero-delta');
  if (last.change === 0 && dir !== 'START') {
    deltaEl.textContent = 'no change from last check';
    deltaEl.className = 'hero-delta';
  } else if (dir === 'START') {
    deltaEl.textContent = 'baseline';
    deltaEl.className = 'hero-delta';
  } else {
    const sign = last.change >= 0 ? '+' : '−';
    deltaEl.textContent = `${sign}${INR(Math.abs(last.change), 2)} (${PCT(last.pct_change)})`;
    deltaEl.className = 'hero-delta ' + (last.change >= 0 ? 'up' : 'down');
  }

  $('#hero-rate').textContent = last.rate ? last.rate.toExponential(4) : '—';
}

/* ---------------- Advisory ---------------- */
function renderAdvisory() {
  const a = currentPayload?.analytics;
  const box = $('#advisory');
  box.classList.remove('convert', 'convert-soft', 'hold', 'hold-risky');
  if (a?.level) box.classList.add(a.level);
  $('#advisory-msg').textContent = a?.advisory || 'Waiting for more data…';
}

/* ---------------- Table + search ---------------- */
function renderTable(filter = '') {
  const tbody = $('#history-table tbody');
  const rows = fullHistory.slice(-50).reverse();
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => `${r.date} ${r.time} ${r.direction}`.toLowerCase().includes(q))
    : rows.slice(0, 20);
  tbody.innerHTML = filtered
    .map((r) => {
      const dirClass = r.direction === 'UP' ? 'up' : r.direction === 'DOWN' ? 'down' : '';
      const dDate = new Date(`${r.date}T${r.time}`);
      const niceWhen = dDate.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      return `<tr>
        <td>${niceWhen}</td>
        <td class="mono">${r.rate ? r.rate.toExponential(4) : '—'}</td>
        <td class="num">${INR(r.inr, 0)}</td>
        <td class="num ${dirClass}">${r.change > 0 ? '+' : ''}${INR(r.change, 0)}</td>
        <td class="num ${dirClass}">${PCT(r.pct_change)}</td>
        <td><span class="tag ${r.direction.toLowerCase()}" style="padding:2px 8px;font-size:10px">${r.direction}</span></td>
      </tr>`;
    })
    .join('');
}

$('#table-search').addEventListener('input', (e) => renderTable(e.target.value));

/* ---------------- Range control ---------------- */
$('#range-controls').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  $$('#range-controls button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  activeRange = btn.dataset.range;
  renderMainChart();
});

/* ---------------- Refresh ---------------- */
$('#refresh-link').addEventListener('click', (e) => {
  e.preventDefault();
  load();
});

/* ---------------- Resize ---------------- */
function redrawAll() {
  Object.values(charts).forEach((c) => c && c.resize());
  renderSparkline();
  renderMainChart();
  renderDelta();
  renderGauge();
  renderHeatmap();
}
window.addEventListener('resize', () => {
  Object.values(charts).forEach((c) => c && c.resize());
});

/* ---------------- Load ---------------- */
const safe = (fn, label) => {
  try { fn(); } catch (e) { console.error(`[${label}]`, e); }
};

async function load() {
  let payload;
  try {
    const res = await fetch(`data.json?t=${Date.now()}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    payload = await res.json();
  } catch (e) {
    $('#err').classList.remove('hidden');
    $('#err').textContent = `Could not load data.json — ${e.message}. Make sure the tracker has run at least once.`;
    return;
  }

  currentPayload = payload;
  fullHistory = (payload.history || []).sort((a, b) => tsOf(a) - tsOf(b));

  $('#updated').textContent = `Updated ${payload.updated_display || payload.updated_iso} · ${fullHistory.length} checks`;
  $('#main').setAttribute('aria-busy', 'false');

  if (typeof echarts === 'undefined') {
    $('#err').classList.remove('hidden');
    $('#err').textContent = 'Charts library failed to load (offline or CDN blocked). Data panels above still work.';
  }

  safe(renderHero, 'hero');
  safe(renderAdvisory, 'advisory');
  safe(renderStats, 'stats');
  safe(renderTable, 'table');
  if (typeof echarts === 'undefined') return;
  safe(renderSparkline, 'spark');
  safe(renderMainChart, 'main-chart');
  safe(renderDelta, 'delta');
  safe(renderGauge, 'gauge');
  safe(renderHeatmap, 'heatmap');
}

load();
