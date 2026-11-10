import { initMotion, animateData, cancelDataMotion, cancelMotion } from './motion.js';
import {
  RANGE_PRESETS,
  amountOf,
  applyFilters,
  buildColorMap,
  compactNumber,
  dailySeries,
  diffDays,
  dimValue,
  formatDate,
  formatMoney,
  granularityFor,
  listCurrencies,
  listValues,
  monthBounds,
  monthLabel,
  monthOf,
  monthlySeries,
  niceScale,
  percentChange,
  previousRange,
  rankBy,
  resolveRange,
  slotOf,
  summarize,
  summarizeSubscriptions,
} from './analytics.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAGE_SIZE = 50;
const STALE_DAYS = 3;
const PREFS_KEY = 'email-spend-agent.dashboard.prefs';
const THEME_KEY = 'email-spend-agent.dashboard.theme';

const SEGMENT_OPTIONS = [
  { id: 'none', label: 'Sin segmentar' },
  { id: 'categoria', label: 'Categoría' },
  { id: 'canal', label: 'Canal' },
  { id: 'banco', label: 'Banco' },
];

const BREAKDOWN_OPTIONS = [
  { id: 'categoria', label: 'Categoría', singular: 'categoría', plural: 'categorías' },
  { id: 'vendor', label: 'Comercio', singular: 'comercio', plural: 'comercios' },
  { id: 'canal', label: 'Canal', singular: 'canal', plural: 'canales' },
  { id: 'banco', label: 'Banco', singular: 'banco', plural: 'bancos' },
];

const VIEW_OPTIONS = [
  { id: 'chart', label: 'Gráfica' },
  { id: 'table', label: 'Tabla' },
];

const TABLE_COLUMNS = [
  { key: 'fecha', label: 'Fecha', defaultDir: 'desc' },
  { key: 'vendor', label: 'Comercio', defaultDir: 'asc' },
  { key: 'categoria', label: 'Categoría', defaultDir: 'asc' },
  { key: 'canal', label: 'Canal', defaultDir: 'asc' },
  { key: 'banco', label: 'Banco', defaultDir: 'asc' },
  { key: 'monto', label: 'Monto', defaultDir: 'desc', numeric: true },
];

const $ = (id) => document.getElementById(id);

// ---------- DOM helpers ----------
// Todo texto que viene de los datos (comercios, categorías) entra por
// textContent / nodos de texto, nunca por innerHTML: son strings de correos.

function make(ns, tag, props, children) {
  const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const h = (tag, props, ...children) => make(null, tag, props, children);
const svg = (tag, props, ...children) => make(SVG_NS, tag, props, children);

// ---------- Estado ----------

const state = {
  data: null,
  today: localToday(),
  preset: '365',
  custom: { from: '', to: '' },
  filters: { moneda: '', categoria: '', canal: '', banco: '', query: '', hideTransfers: false },
  segmentBy: 'none',
  breakdownDim: 'categoria',
  monthlyView: 'chart',
  breakdownView: 'chart',
  sort: { key: 'fecha', dir: 'desc' },
  shown: PAGE_SIZE,
  colorMaps: {},
};

let monthlyRedraw = null;
let lastWidth = 0;

function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // modo privado o almacenamiento bloqueado: la página funciona igual
  }
}

function loadPrefs() {
  try {
    const prefs = JSON.parse(readStorage(PREFS_KEY) ?? '{}');
    if (RANGE_PRESETS.some((preset) => preset.id === prefs.preset) && prefs.preset !== 'custom') state.preset = prefs.preset;
    if (typeof prefs.hideTransfers === 'boolean') state.filters.hideTransfers = prefs.hideTransfers;
    if (SEGMENT_OPTIONS.some((o) => o.id === prefs.segmentBy)) state.segmentBy = prefs.segmentBy;
    if (BREAKDOWN_OPTIONS.some((o) => o.id === prefs.breakdownDim)) state.breakdownDim = prefs.breakdownDim;
    if (typeof prefs.moneda === 'string') state.filters.moneda = prefs.moneda;
  } catch {
    // prefs corruptas: se ignoran
  }
  applyUrlParams();
}

// La URL manda sobre las preferencias guardadas, para poder marcar o compartir
// una vista: ?period=90&segment=categoria&dim=vendor&hide=1&currency=USD&view=table
function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const period = params.get('period');
  const segment = params.get('segment');
  const dim = params.get('dim');

  if (RANGE_PRESETS.some((preset) => preset.id === period) && period !== 'custom') state.preset = period;
  if (SEGMENT_OPTIONS.some((option) => option.id === segment)) state.segmentBy = segment;
  if (BREAKDOWN_OPTIONS.some((option) => option.id === dim)) state.breakdownDim = dim;
  if (params.has('hide')) state.filters.hideTransfers = params.get('hide') === '1';
  if (params.get('currency')) state.filters.moneda = params.get('currency');
  if (params.get('view') === 'table') {
    state.monthlyView = 'table';
    state.breakdownView = 'table';
  }
}

function savePrefs() {
  writeStorage(
    PREFS_KEY,
    JSON.stringify({
      preset: state.preset,
      hideTransfers: state.filters.hideTransfers,
      segmentBy: state.segmentBy,
      breakdownDim: state.breakdownDim,
      moneda: state.filters.moneda,
    })
  );
}

// ---------- Tema ----------

function currentTheme() {
  return (
    document.documentElement.dataset.theme ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

function refreshThemeButton() {
  const dark = currentTheme() === 'dark';
  const button = $('btn-theme');
  button.setAttribute('aria-label', dark ? 'Activar tema claro' : 'Activar tema oscuro');
  button.setAttribute('title', dark ? 'Activar tema claro' : 'Activar tema oscuro');
  button.setAttribute('data-dark', String(dark));
}

function initTheme() {
  const requested = new URLSearchParams(location.search).get('theme');
  const theme = ['light', 'dark'].includes(requested) ? requested : readStorage(THEME_KEY);
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  refreshThemeButton();

  $('btn-theme').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    writeStorage(THEME_KEY, next);
    refreshThemeButton();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshThemeButton);
}

// ---------- Tooltip ----------

const tip = $('tooltip');

function showTip(nodes) {
  tip.replaceChildren(...nodes);
  tip.hidden = false;
}

function moveTip(x, y) {
  const gap = 14;
  const rect = tip.getBoundingClientRect();
  let left = x + gap;
  let top = y + gap;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - gap;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - gap;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip() {
  tip.hidden = true;
}

// Mismo contenido por puntero que por teclado: el tooltip nunca es la única vía.
function bindTip(target, buildNodes, { onActivate } = {}) {
  const enter = (event) => {
    showTip(buildNodes());
    moveTip(event.clientX, event.clientY);
  };
  target.addEventListener('pointerenter', enter);
  target.addEventListener('pointermove', (event) => moveTip(event.clientX, event.clientY));
  target.addEventListener('pointerleave', hideTip);
  target.addEventListener('focus', () => {
    showTip(buildNodes());
    const rect = target.getBoundingClientRect();
    moveTip(rect.left + rect.width / 2, rect.top);
  });
  target.addEventListener('blur', hideTip);

  if (onActivate) {
    target.addEventListener('click', onActivate);
    target.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    });
  }
}

const tipTitle = (text) => h('div', { class: 'tip-title' }, text);
const tipValue = (text) => h('div', { class: 'tip-value' }, text);
const tipRow = (slot, name, value) =>
  h('div', { class: 'tip-row' }, h('span', { class: `tip-key s${slot}` }), h('span', null, name), h('strong', null, value));

// ---------- Controles ----------

function segmented(container, options, active, onPick) {
  container.replaceChildren(
    ...options.map((option) =>
      h('button', { type: 'button', 'aria-pressed': String(option.id === active), onclick: () => onPick(option.id) }, option.label)
    )
  );
}

function replaceSelectOptions(select, options) {
  // selectedcontent permite truncar el valor visible sin acortar las opciones.
  // El navegador sigue gestionando selección, teclado y accesibilidad.
  const button = CSS.supports('appearance', 'base-select')
    ? [h('button', { type: 'button' }, h('selectedcontent'))]
    : [];
  select.replaceChildren(...button, ...options);
}

function fillSelect(select, values, current, allLabel = 'Todas') {
  replaceSelectOptions(select, [
    h('option', { value: '' }, allLabel),
    ...values.map((value) => h('option', { value, selected: value === current }, value))
  ]);
  select.value = values.includes(current) ? current : '';
}

function currentRange() {
  return resolveRange(state.preset, state.today, state.data?.gastos ?? [], state.custom);
}

function hasActiveFilters() {
  const { categoria, canal, banco, query, hideTransfers } = state.filters;
  return Boolean(categoria || canal || banco || query.trim() || hideTransfers);
}

function syncControls() {
  $('f-range').value = state.preset;
  $('custom-range').hidden = state.preset !== 'custom';
  const range = currentRange();
  $('f-from').value = state.preset === 'custom' ? state.custom.from : range.from;
  $('f-to').value = state.preset === 'custom' ? state.custom.to : range.to;

  segmented(
    $('f-currency'),
    listCurrencies(state.data.gastos).map((currency) => ({ id: currency, label: currency })),
    state.filters.moneda,
    (moneda) => {
      state.filters.moneda = moneda;
      update();
    }
  );

  $('f-categoria').value = state.filters.categoria;
  $('f-canal').value = state.filters.canal;
  $('f-banco').value = state.filters.banco;
  if ($('f-query').value !== state.filters.query) $('f-query').value = state.filters.query;
  $('f-transfers').checked = state.filters.hideTransfers;
  $('btn-clear').hidden = !hasActiveFilters();
}

function setupFilterOptions() {
  const gastos = state.data.gastos;
  fillSelect($('f-categoria'), listValues(gastos, 'categoria'), state.filters.categoria);
  fillSelect($('f-canal'), listValues(gastos, 'canal'), state.filters.canal);
  fillSelect($('f-banco'), listValues(gastos, 'banco'), state.filters.banco);
  state.filters.categoria = $('f-categoria').value;
  state.filters.canal = $('f-canal').value;
  state.filters.banco = $('f-banco').value;
}

function wireControls() {
  replaceSelectOptions($('f-range'), RANGE_PRESETS.map((preset) => h('option', { value: preset.id }, preset.label)));

  $('filters').addEventListener('submit', (event) => event.preventDefault());

  $('f-range').addEventListener('change', (event) => {
    const next = event.target.value;
    if (next === 'custom') {
      // arranca desde lo que se estaba viendo, no desde un rango vacío
      const range = currentRange();
      state.custom = { from: range.from, to: range.to };
    }
    state.preset = next;
    update();
  });

  for (const id of ['f-from', 'f-to']) {
    $(id).addEventListener('change', () => {
      state.custom = { from: $('f-from').value, to: $('f-to').value };
      state.preset = 'custom';
      update();
    });
  }

  for (const dim of ['categoria', 'canal', 'banco']) {
    $(`f-${dim}`).addEventListener('change', (event) => {
      state.filters[dim] = event.target.value;
      update();
    });
  }

  let queryTimer;
  $('f-query').addEventListener('input', (event) => {
    window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => {
      state.filters.query = event.target.value;
      update();
    }, 150);
  });

  $('f-transfers').addEventListener('change', (event) => {
    state.filters.hideTransfers = event.target.checked;
    update();
  });

  $('btn-clear').addEventListener('click', () => {
    Object.assign(state.filters, { categoria: '', canal: '', banco: '', query: '', hideTransfers: false });
    update();
  });

  $('btn-refresh').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.classList.add('is-refreshing');
    button.setAttribute('aria-label', 'Recargando gastos guardados');
    try {
      await load();
    } finally {
      button.disabled = false;
      button.classList.remove('is-refreshing');
      button.setAttribute('aria-label', 'Recargar gastos guardados');
    }
  });
  $('btn-csv').addEventListener('click', exportCsv);
  $('movement-close').addEventListener('click', () => $('movement-dialog').close());
  $('movement-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
}

// ---------- Datos ----------

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
}

async function load() {
  const content = $('content');
  content.classList.add('is-loading'); // conserva el último render a opacidad reducida
  if (content.hidden) setStatus('Cargando gastos…');

  try {
    const response = await fetch('/dashboard/api/data', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  } catch (err) {
    setStatus(`No se pudieron cargar los gastos (${err.message}).`, true);
    content.classList.remove('is-loading');
    return;
  }

  state.today = localToday();
  state.firstDate = state.data.gastos.map((gasto) => gasto.fecha).sort()[0] ?? state.today;
  setStatus('');

  if (state.data.gastos.length === 0) {
    content.hidden = true;
    setStatus('Todavía no hay gastos guardados. Cuando el poller encuentre cobros aparecerán aquí.');
    return;
  }

  const currencies = listCurrencies(state.data.gastos);
  if (!currencies.includes(state.filters.moneda)) state.filters.moneda = currencies[0] ?? '';

  state.colorMaps = {
    categoria: buildColorMap(state.data.gastos, 'categoria'),
    canal: buildColorMap(state.data.gastos, 'canal'),
    banco: buildColorMap(state.data.gastos, 'banco'),
  };

  setupFilterOptions();
  renderFreshness();
  content.hidden = false;
  update();
  content.classList.remove('is-loading');
}

function update() {
  state.shown = PAGE_SIZE;
  savePrefs();
  syncControls();
  render();
  animateData();
}

// Días desde el último gasto registrado hasta hoy.
function dataAge() {
  return state.data.ultimaFecha ? diffDays(state.data.ultimaFecha, state.today) : 0;
}

function renderFreshness() {
  const chip = $('freshness');
  const last = state.data.ultimaFecha;
  if (!last) {
    chip.hidden = true;
    return;
  }

  const age = dataAge();
  chip.hidden = false;
  chip.classList.toggle('is-stale', age > STALE_DAYS);
  chip.textContent =
    age > STALE_DAYS
      ? `⚠ Sin gastos nuevos hace ${age} días (último: ${formatDate(last)})`
      : `Último gasto: ${formatDate(last)}`;
}

// ---------- Render ----------

function render() {
  cancelDataMotion();
  hideTip();
  const range = currentRange();
  const filters = { ...state.filters, ...range };
  const slice = applyFilters(state.data.gastos, filters);
  // Solo se compara contra un período anterior que los datos cubren completo:
  // si empieza antes del primer registro, "sube 487%" sería un artefacto.
  const previousBounds = previousRange(range);
  const previous =
    state.preset === 'all' || previousBounds.from < state.firstDate
      ? null
      : applyFilters(state.data.gastos, { ...filters, ...previousBounds });

  renderKpis(slice, previous, range);
  renderMonthly(slice, range);
  renderBreakdown(slice);
  renderSubscriptions();
  renderTable(slice);
}

const rangeText = (range) => `${formatDate(range.from)} – ${formatDate(range.to)}`;
const money = (value, options) => formatMoney(value, state.filters.moneda, options);

function emptyState(title, hint) {
  return h('div', { class: 'empty' }, h('strong', null, title), hint);
}

// ----- KPIs -----

function tile({ label, value, sub, extra, hero }) {
  return h(
    'div',
    { class: hero ? 'tile hero' : 'tile' },
    h('p', { class: 'tile-label' }, label),
    h('p', { class: 'tile-value' }, value),
    extra,
    sub ? h('p', { class: 'tile-sub' }, sub) : null
  );
}

function deltaNode(change) {
  if (change == null) return null;
  const percent = Math.round(Math.abs(change) * 100);
  if (percent === 0) return h('p', { class: 'delta' }, 'Sin cambios frente al período anterior');
  const up = change > 0;
  return h(
    'p',
    { class: 'delta' },
    h('span', { class: `delta-icon ${up ? 'up' : 'down'}`, 'aria-hidden': 'true' }, up ? '▲' : '▼'),
    ` ${up ? 'Sube' : 'Baja'} ${percent}% frente al período anterior`
  );
}

function renderKpis(slice, previous, range) {
  const summary = summarize(slice);
  const days = diffDays(range.from, range.to) + 1;
  const months = Math.max(1, days / 30.4375);
  const subs = summarizeSubscriptions(state.data.suscripciones, state.filters.moneda, state.today);
  const change = previous ? percentChange(summary.total, summarize(previous).total) : null;

  $('kpis').replaceChildren(
    tile({
      hero: true,
      label: 'Total gastado',
      value: money(summary.total, { decimals: 0 }),
      extra: deltaNode(change),
      sub: `${summary.count} ${summary.count === 1 ? 'cobro' : 'cobros'} · ${rangeText(range)}`,
    }),
    tile({
      label: 'Promedio por mes',
      value: money(summary.total / months, { decimals: 0 }),
      sub: months >= 1.5 ? `En ${months.toFixed(1)} meses` : 'Período de alrededor de un mes',
    }),
    tile({
      label: 'Cobro promedio',
      value: money(summary.average),
      sub: `Entre ${summary.count} cobros`,
    }),
    tile({
      label: 'Mayor gasto',
      value: summary.largest ? money(amountOf(summary.largest)) : '—',
      sub: summary.largest ? `${summary.largest.vendor} · ${formatDate(summary.largest.fecha)}` : 'Sin cobros en el período',
    }),
    tile({
      label: 'Suscripciones',
      value: String(subs.items.length),
      sub: subs.items.length ? `≈ ${money(subs.mensual)} al mes` : 'Ninguna activa en esta moneda',
    })
  );
}

// ----- Gasto por mes / por día -----

function seriesFor(slice, range) {
  const segmentBy = state.segmentBy === 'none' ? null : state.segmentBy;
  const options = { from: range.from, to: range.to, segmentBy, colorMap: state.colorMaps[state.segmentBy] ?? new Map() };
  const granularity = granularityFor(range);
  return { granularity, series: granularity === 'day' ? dailySeries(slice, options) : monthlySeries(slice, options) };
}

function bucketTitle(key, granularity) {
  return granularity === 'day' ? formatDate(key) : `${monthLabel(key)} ${key.slice(0, 4)}`;
}

function renderMonthly(slice, range) {
  const { granularity, series } = seriesFor(slice, range);
  const perDay = granularity === 'day';
  const segmentBy = state.segmentBy === 'none' ? null : state.segmentBy;
  const colorMap = state.colorMaps[state.segmentBy] ?? new Map();

  $('h-monthly').textContent = perDay ? 'Gasto por día' : 'Gasto por mes';
  $('monthly-sub').textContent = `${state.filters.moneda} · ${rangeText(range)}`;
  segmented($('seg-by'), SEGMENT_OPTIONS, state.segmentBy, (id) => {
    state.segmentBy = id;
    update();
  });
  segmented($('view-monthly'), VIEW_OPTIONS, state.monthlyView, (id) => {
    state.monthlyView = id;
    update();
  });

  $('monthly-legend').replaceChildren(
    ...(segmentBy
      ? series.segments.map((key) =>
          h('span', { class: 'legend-item' }, h('span', { class: `swatch s${slotOf(key, colorMap)}` }), key)
        )
      : [])
  );

  const box = $('monthly-chart');
  monthlyRedraw = null;

  if (slice.length === 0) {
    box.replaceChildren(emptyState('Sin gastos con estos filtros', 'Amplía el período o limpia los filtros.'));
    return;
  }

  if (state.monthlyView === 'table') {
    box.replaceChildren(seriesTable(series, granularity, segmentBy));
    return;
  }

  monthlyRedraw = () => {
    cancelMotion(box);
    box.replaceChildren(drawColumns(box, series, granularity, segmentBy, colorMap));
    // Evita que la primera notificación de tamaño interrumpa la entrada del gráfico.
    lastWidth = box.clientWidth;
  };
  monthlyRedraw();
}

function seriesTable(series, granularity, segmentBy) {
  const head = [granularity === 'day' ? 'Día' : 'Mes', 'Cobros', ...series.segments, 'Total'];
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, head.map((label, index) => h('th', { class: index > 0 ? 'num' : null }, label)))),
      h(
        'tbody',
        null,
        series.rows.map((row) =>
          h(
            'tr',
            null,
            h('td', null, bucketTitle(row.key, granularity)),
            h('td', { class: 'num' }, row.count),
            segmentBy ? series.segments.map((key) => h('td', { class: 'num' }, money(row.parts.get(key) ?? 0))) : null,
            h('td', { class: 'num' }, money(row.total))
          )
        )
      )
    )
  );
}

// Rectángulo con las dos esquinas superiores redondeadas (el extremo de los
// datos) y base recta sobre el eje.
function roundedTopPath(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height);
  return `M${x} ${y + height}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + width - r}Q${x + width} ${y} ${x + width} ${y + r}V${y + height}Z`;
}

function drawColumns(box, series, granularity, segmentBy, colorMap) {
  const { rows, segments, max } = series;
  const perDay = granularity === 'day';
  const width = Math.max(300, Math.floor(box.clientWidth));
  const height = 290;
  const margin = { top: 24, right: 8, bottom: 38, left: 44 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const scale = niceScale(max, 5);
  const yOf = (value) => margin.top + plotHeight - (value / scale.max) * plotHeight;
  const band = plotWidth / rows.length;
  const barWidth = Math.max(3, Math.min(24, band * 0.6));
  const labelStep = Math.max(1, Math.ceil((perDay ? 24 : 40) / band));
  const peakIndex = rows.findIndex((row) => row.total === max);
  const currentMonth = monthOf(state.today);

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'group',
    'aria-label': `${perDay ? 'Gasto por día' : 'Gasto por mes'}: ${rows.length} ${perDay ? 'días' : 'meses'}`,
  });

  for (const tick of scale.ticks) {
    const y = yOf(tick);
    root.append(
      svg('line', { class: tick === 0 ? 'axis-line' : 'grid-line', x1: margin.left, x2: width - margin.right, y1: y, y2: y }),
      svg('text', { class: 'tick', x: margin.left - 8, y: y + 4, 'text-anchor': 'end' }, compactNumber(tick))
    );
  }

  rows.forEach((row, index) => {
    const slotLeft = margin.left + band * index;
    const centerX = slotLeft + band / 2;
    const group = svg('g', { class: 'col' });
    const bars = svg('g', { class: 'bar-stack' });
    group.append(bars);

    // Un solo bloque (sin segmentar) o la pila en el orden de color de la leyenda.
    const parts = segmentBy
      ? segments.map((key) => ({ key, value: row.parts.get(key) ?? 0, slot: slotOf(key, colorMap) })).filter((p) => p.value > 0)
      : row.total > 0
        ? [{ key: 'total', value: row.total, slot: 1 }]
        : [];

    let base = yOf(0);
    parts.forEach((part, partIndex) => {
      const full = Math.max(1, (part.value / scale.max) * plotHeight);
      const isTop = partIndex === parts.length - 1;
      // 2px de superficie entre segmentos, recortados desde abajo para que la
      // altura total de la pila siga siendo la real.
      const visible = partIndex === 0 ? full : Math.max(1, full - 2);
      const top = base - full;
      const x = centerX - barWidth / 2;

      bars.append(
        isTop
          ? svg('path', { class: `bar s${part.slot}`, d: roundedTopPath(x, top, barWidth, visible, 4) })
          : svg('rect', { class: `bar s${part.slot}`, x, y: top, width: barWidth, height: visible })
      );
      base = top;
    });

    if (index % labelStep === 0) {
      const first = index === 0;
      const dayNumber = row.key.slice(8, 10);
      const monthKey = perDay ? row.key.slice(0, 7) : row.key;
      const startsMonth = perDay ? row.key.endsWith('-01') : false;
      const startsYear = !perDay && (monthKey.endsWith('-01') || first);

      group.append(
        svg('text', { class: 'tick', x: centerX, y: height - 20, 'text-anchor': 'middle' }, perDay ? String(Number(dayNumber)) : monthLabel(monthKey))
      );
      if (perDay && (first || startsMonth)) {
        group.append(svg('text', { class: 'tick', x: centerX, y: height - 6, 'text-anchor': 'middle' }, monthLabel(monthKey)));
      } else if (startsYear) {
        group.append(svg('text', { class: 'tick', x: centerX, y: height - 6, 'text-anchor': 'middle' }, monthKey.slice(0, 4)));
      }
    }

    if (index === peakIndex && max > 0) {
      const x = Math.min(width - margin.right - 28, Math.max(margin.left + 28, centerX));
      group.append(svg('text', { class: 'peak-label', x, y: yOf(row.total) - 7, 'text-anchor': 'middle' }, money(row.total, { decimals: 0 })));
    }

    const inProgress = !perDay && row.key === currentMonth;
    const label = `${bucketTitle(row.key, granularity)}: ${money(row.total)}, ${row.count} ${row.count === 1 ? 'cobro' : 'cobros'}`;
    const hit = svg('rect', {
      class: 'col-hit',
      x: slotLeft,
      y: margin.top,
      width: band,
      height: plotHeight,
      tabindex: '0',
      role: perDay ? 'img' : 'button',
      'aria-label': perDay ? label : `${label}. Ver este mes`,
    });

    const buildTip = () => {
      group.classList.add('is-hover');
      const nodes = [
        tipTitle(`${bucketTitle(row.key, granularity)}${inProgress ? ' · mes en curso' : ''}`),
        tipValue(money(row.total)),
      ];
      if (segmentBy) {
        // de arriba hacia abajo, igual que se lee la pila
        for (const key of [...segments].reverse()) {
          const value = row.parts.get(key);
          if (value) nodes.push(tipRow(slotOf(key, colorMap), key, money(value)));
        }
      }
      nodes.push(h('div', { class: 'tip-hint' }, `${row.count} ${row.count === 1 ? 'cobro' : 'cobros'}${perDay ? '' : ' · clic para ver este mes'}`));
      return nodes;
    };

    bindTip(hit, buildTip, { onActivate: perDay ? null : () => drillIntoMonth(row.key) });
    hit.addEventListener('pointerleave', () => group.classList.remove('is-hover'));
    hit.addEventListener('blur', () => group.classList.remove('is-hover'));

    group.append(hit);
    root.append(group);
  });

  return root;
}

function drillIntoMonth(month) {
  const bounds = monthBounds(month);
  state.custom = { from: bounds.from, to: bounds.to };
  state.preset = 'custom';
  hideTip();
  update();
}

// ----- Desglose (ranking) -----

function applyDimensionFilter(dim, key) {
  if (dim === 'vendor') state.filters.query = state.filters.query === key ? '' : key;
  else state.filters[dim] = state.filters[dim] === key ? '' : key;
  update();
}

function renderBreakdown(slice) {
  const option = BREAKDOWN_OPTIONS.find((o) => o.id === state.breakdownDim);
  const dim = option.id;
  const limit = dim === 'vendor' ? 10 : undefined;
  const ranking = rankBy(slice, dim, { limit });

  segmented($('seg-dim'), BREAKDOWN_OPTIONS, dim, (id) => {
    state.breakdownDim = id;
    update();
  });
  segmented($('view-breakdown'), VIEW_OPTIONS, state.breakdownView, (id) => {
    state.breakdownView = id;
    update();
  });

  $('breakdown-sub').textContent = `${ranking.distinct} ${ranking.distinct === 1 ? option.singular : option.plural} · ${money(ranking.total, { decimals: 0 })}`;

  const shownTotal = ranking.rows.reduce((sum, row) => sum + row.total, 0);
  $('breakdown-foot').textContent =
    limit && ranking.distinct > limit && ranking.total > 0
      ? `Top ${limit} de ${ranking.distinct} comercios · ${Math.round((shownTotal / ranking.total) * 100)}% del total. Clic en una fila para filtrar.`
      : slice.length
        ? 'Clic en una fila para filtrar por ese valor.'
        : '';

  const body = $('breakdown-body');
  if (slice.length === 0) {
    body.replaceChildren(emptyState('Sin gastos con estos filtros', 'Amplía el período o limpia los filtros.'));
    return;
  }

  if (state.breakdownView === 'table') {
    body.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, option.label), h('th', { class: 'num' }, 'Cobros'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, '%'))),
          h(
            'tbody',
            null,
            ranking.rows.map((row) =>
              h('tr', null, h('td', { class: 'cell-vendor' }, row.key), h('td', { class: 'num' }, row.count), h('td', { class: 'num' }, money(row.total)), h('td', { class: 'num' }, `${Math.round(row.share * 100)}%`))
            )
          )
        )
      )
    );
    return;
  }

  const peak = Math.max(...ranking.rows.map((row) => row.total), 0);
  body.replaceChildren(
    h(
      'ol',
      { class: 'rank' },
      ranking.rows.map((row) => {
        // Fracción respecto de la barra más larga; el CSS la multiplica por el
        // tope del carril (--cap), que deja lugar para el valor afuera del
        // extremo sin recortarlo ni desbordar la tarjeta.
        const fraction = peak > 0 ? Math.max(0, row.total / peak) : 0;
        const button = h(
          'button',
          { type: 'button', class: 'rank-btn', 'aria-label': `${row.key}: ${money(row.total)}, ${Math.round(row.share * 100)}%. Filtrar por este valor` },
          h('span', { class: 'rank-label', title: row.key }, row.key),
          h(
            'span',
            { class: 'rank-track' },
            h('span', { class: 'rank-fill' }),
            h('span', { class: 'rank-value' }, money(row.total, { decimals: 0 }), h('small', null, `${Math.round(row.share * 100)}%`))
          )
        );
        button.querySelector('.rank-track').style.setProperty('--f', String(fraction));

        bindTip(
          button,
          () => [
            tipTitle(row.key),
            tipValue(money(row.total)),
            h('div', { class: 'tip-row' }, `${row.count} ${row.count === 1 ? 'cobro' : 'cobros'} · ${Math.round(row.share * 100)}% del total`),
          ],
          { onActivate: () => applyDimensionFilter(dim, row.key) }
        );
        return h('li', null, button);
      })
    )
  );
}

// ----- Suscripciones -----

function dueText(days) {
  if (days < 0) return { text: `venció hace ${-days} ${days === -1 ? 'día' : 'días'}`, late: true };
  if (days === 0) return { text: 'hoy', late: false };
  if (days === 1) return { text: 'mañana', late: false };
  return { text: `en ${days} días`, late: false };
}

function renderSubscriptions() {
  const subs = summarizeSubscriptions(state.data.suscripciones, state.filters.moneda, state.today);
  const body = $('subs-body');

  if (subs.items.length === 0) {
    // Con datos atrasados todas figuran como vencidas: se aclara en vez de
    // dejar creer que no hay suscripciones.
    const age = dataAge();
    const hint =
      age > STALE_DAYS
        ? `Los datos llegan hasta el ${formatDate(state.data.ultimaFecha)}: sin cobros recientes, todas se consideran vencidas. Al ponerlos al día se recalculan.`
        : 'Se detectan con 2 o más cobros periódicos.';
    body.replaceChildren(emptyState(`Sin suscripciones activas en ${state.filters.moneda}`, hint));
    $('subs-foot').textContent = '';
    return;
  }

  body.replaceChildren(
    h(
      'ul',
      { class: 'subs' },
      subs.items.map((item) => {
        const due = dueText(item.diasParaCobro);
        const first = item.historial?.[0]?.monto;
        const priceChanged = first && Math.abs(item.montoActual - first) / Math.max(item.montoActual, first) > 0.05;

        return h(
          'li',
          { class: 'sub-row' },
          h(
            'div',
            null,
            h('div', { class: 'sub-name' }, item.vendor),
            h('div', { class: 'sub-meta' }, `${item.frecuencia} · ${item.ocurrencias} cobros · último ${formatDate(item.ultimoCobro)}`),
            priceChanged
              ? h('div', { class: 'sub-meta badge-up' }, `${item.montoActual > first ? 'Subió' : 'Bajó'} de ${money(first)}`)
              : null
          ),
          h(
            'div',
            { class: 'sub-right' },
            h('div', { class: 'sub-amount' }, money(item.montoActual)),
            h('div', { class: due.late ? 'sub-meta badge-late' : 'sub-meta' }, `Próximo ${due.text} · ${formatDate(item.proximoEstimado).slice(0, -5)}`)
          )
        );
      })
    )
  );

  $('subs-foot').textContent = `≈ ${money(subs.mensual)} al mes · ${money(subs.anual, { decimals: 0 })} al año (los anuales se prorratean)`;
}

// ----- Movimientos -----

function receivedAt(value) {
  if (!value) return 'Sin dato';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin dato';
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima',
  }).format(date);
}

function paymentMethod(canal) {
  const value = String(canal ?? '').toLowerCase();
  if (value === 'tarjeta') return 'Tarjeta';
  if (['yape', 'plin', 'mercado pago', 'modo'].includes(value)) return 'Billetera digital';
  if (value === 'transferencia') return 'Transferencia';
  if (value === 'cajero') return 'Cajero (efectivo)';
  return 'No especificado';
}

function movementField(label, value) {
  return h('div', { class: 'movement-field' }, h('dt', null, label), h('dd', null, value));
}

function openMovement(record) {
  $('movement-vendor').textContent = record.vendor || 'Sin comercio';
  $('movement-body').replaceChildren(
    h('p', { class: 'movement-amount' }, Number.isFinite(record.monto) && record.monto !== 0 ? money(record.monto) : 'Sin monto registrado'),
    h('dl', { class: 'movement-fields' },
      movementField('Fecha del movimiento', formatDate(record.fecha)),
      movementField('Correo recibido', receivedAt(record.hora)),
      movementField('Categoría', dimValue(record, 'categoria')),
      movementField('Medio detectado', paymentMethod(record.canal)),
      movementField('Canal registrado', dimValue(record, 'canal')),
      movementField('Banco', dimValue(record, 'banco')),
      movementField('Moneda', dimValue(record, 'moneda')),
    ),
    h('p', { class: 'movement-note' }, 'La hora corresponde a la recepción del correo, no al momento exacto del cobro.')
  );
  $('movement-dialog').showModal();
}

function sortedRecords(slice) {
  const { key, dir } = state.sort;
  const factor = dir === 'asc' ? 1 : -1;
  const column = TABLE_COLUMNS.find((c) => c.key === key);

  return [...slice].sort((a, b) => {
    const result = column.numeric
      ? amountOf(a) - amountOf(b)
      : String(dimValue(a, key)).localeCompare(String(dimValue(b, key)), 'es');
    return result * factor || (a.fecha < b.fecha ? 1 : -1);
  });
}

function renderTable(slice) {
  const rows = sortedRecords(slice);
  const total = rows.reduce((sum, record) => sum + amountOf(record), 0);
  $('table-sub').textContent = `${rows.length} ${rows.length === 1 ? 'movimiento' : 'movimientos'} · ${money(total)}`;
  $('btn-csv').disabled = rows.length === 0;

  const body = $('table-body');
  const more = $('table-more');

  if (rows.length === 0) {
    body.replaceChildren(emptyState('Sin movimientos', 'Ajusta el período o los filtros.'));
    more.hidden = true;
    return;
  }

  const colorMap = state.colorMaps.categoria;
  const visible = rows.slice(0, state.shown);

  body.replaceChildren(
    h(
      'div',
      { class: 'table-wrap', role: 'region', 'aria-label': 'Movimientos', tabindex: '0' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            TABLE_COLUMNS.map((column) =>
              h(
                'th',
                {
                  class: column.numeric ? 'num' : null,
                  scope: 'col',
                  'aria-sort': state.sort.key === column.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : null,
                },
                h('button', { type: 'button', onclick: () => sortBy(column) }, column.label)
              )
            )
          )
        ),
        h(
          'tbody',
          null,
          visible.map((record) =>
            h(
              'tr',
              { class: 'movement-row', onclick: () => openMovement(record) },
              h('td', null, formatDate(record.fecha)),
              h('td', { class: 'cell-vendor', title: record.vendor },
                h('button', {
                  type: 'button', class: 'movement-open',
                  'aria-label': `Ver detalle de ${record.vendor || 'movimiento'} del ${formatDate(record.fecha)}`,
                  onclick: (event) => { event.stopPropagation(); openMovement(record); },
                }, h('span', { class: 'movement-open-label' }, record.vendor || 'Sin comercio'), h('span', { class: 'movement-open-icon', 'aria-hidden': 'true' }, '↗'))
              ),
              h('td', null, h('span', { class: 'dot-cell' }, h('span', { class: `swatch s${slotOf(dimValue(record, 'categoria'), colorMap)}` }), dimValue(record, 'categoria'))),
              h('td', null, dimValue(record, 'canal')),
              h('td', null, dimValue(record, 'banco')),
              h('td', { class: 'num' }, Number.isFinite(record.monto) && record.monto !== 0 ? money(record.monto) : '—')
            )
          )
        )
      )
    )
  );

  const remaining = rows.length - visible.length;
  more.hidden = remaining <= 0;
  more.replaceChildren(
    remaining > 0
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: () => {
              state.shown += PAGE_SIZE;
              renderTable(slice);
            },
          },
          `Mostrar más (${remaining} restantes)`
        )
      : ''
  );
}

function sortBy(column) {
  state.sort =
    state.sort.key === column.key
      ? { key: column.key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key: column.key, dir: column.defaultDir };
  state.shown = PAGE_SIZE;
  render();
}

// Los comercios salen de correos (no confiables): una celda que empiece con
// = + - @ se abriría como fórmula en Excel, así que se neutraliza.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv() {
  const range = currentRange();
  const slice = sortedRecords(applyFilters(state.data.gastos, { ...state.filters, ...range }));
  const lines = [
    ['fecha', 'comercio', 'categoria', 'canal', 'banco', 'monto', 'moneda'],
    ...slice.map((r) => [r.fecha, r.vendor, dimValue(r, 'categoria'), dimValue(r, 'canal'), dimValue(r, 'banco'), r.monto ?? '', r.moneda ?? '']),
  ].map((line) => line.map(csvCell).join(','));

  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = h('a', { href: URL.createObjectURL(blob), download: `gastos-${range.from}_${range.to}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

// ---------- Arranque ----------

initTheme();
loadPrefs();
wireControls();
initMotion();

new ResizeObserver(([entry]) => {
  const width = entry.target.clientWidth;
  if (width !== lastWidth && width > 0) {
    lastWidth = width;
    monthlyRedraw?.();
  }
}).observe($('monthly-chart'));

load();
