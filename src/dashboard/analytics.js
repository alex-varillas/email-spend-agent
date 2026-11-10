// Lógica pura del dashboard: sin DOM ni APIs de Node. La importan tanto el
// navegador (app.js) como los tests, así filtros y agregaciones se prueban
// sin levantar un navegador.

export const OTHER_KEY = 'Otros';
export const NO_DATA_KEY = 'Sin dato';
export const TRANSFER_CATEGORY = 'Transferencias personales';
export const MAX_SLOTS = 7;

// Orden fijo de los colores por categoría: el color sigue a la categoría, no
// a su ranking, así un filtro (o datos nuevos) nunca repinta lo ya aprendido.
// Lo que no entra en los 7 espacios cae en gris ("Otros").
const PREFERRED_ORDER = {
  categoria: [
    'Suscripciones/Software',
    'Servicios',
    'Comida',
    'Compras',
    TRANSFER_CATEGORY,
    'Transporte',
    'Entretenimiento',
  ],
};

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const RANGE_PRESETS = [
  { id: 'month', label: 'Este mes' },
  { id: '30', label: 'Últimos 30 días' },
  { id: '90', label: 'Últimos 90 días' },
  { id: '180', label: 'Últimos 6 meses' },
  { id: '365', label: 'Últimos 12 meses' },
  { id: 'all', label: 'Todo el historial' },
  { id: 'custom', label: 'Personalizado' },
];

// ---------- Fechas (siempre strings YYYY-MM-DD, aritmética en UTC) ----------

export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function diffDays(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000);
}

export function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

export function monthBounds(month) {
  const [year, mm] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

// Meses consecutivos [fromMonth, toMonth] inclusive, en formato YYYY-MM.
export function listMonths(fromMonth, toMonth) {
  const months = [];
  let [year, mm] = fromMonth.split('-').map(Number);
  const [endYear, endMonth] = toMonth.split('-').map(Number);
  while (year < endYear || (year === endYear && mm <= endMonth)) {
    months.push(`${year}-${String(mm).padStart(2, '0')}`);
    mm += 1;
    if (mm > 12) {
      mm = 1;
      year += 1;
    }
  }
  return months;
}

export function monthLabel(month) {
  return MONTHS_ES[Number(month.slice(5, 7)) - 1];
}

export function formatDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS_ES[month - 1]} ${year}`;
}

// Rango [from, to] de un preset. `custom` solo aplica a 'custom'.
export function resolveRange(preset, today, records, custom = {}) {
  if (preset === 'month') return { from: `${monthOf(today)}-01`, to: today };

  if (['30', '90', '180', '365'].includes(preset)) {
    return { from: addDays(today, -(Number(preset) - 1)), to: today };
  }

  if (preset === 'all') {
    const dates = records.map((record) => record.fecha).sort();
    const last = dates.at(-1);
    return { from: dates[0] ?? today, to: last && last > today ? last : today };
  }

  const from = custom.from || today;
  const to = custom.to || today;
  return from <= to ? { from, to } : { from: to, to: from };
}

// Período inmediatamente anterior y del mismo largo, para el delta de los KPI.
export function previousRange({ from, to }) {
  const length = diffDays(from, to) + 1;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(length - 1)), to: prevTo };
}

// ---------- Filtros ----------

export function amountOf(record) {
  return Number.isFinite(record.monto) ? record.monto : 0;
}

export function dimValue(record, dim) {
  return record[dim] ?? NO_DATA_KEY;
}

function vendorKey(vendor) {
  return (vendor ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// from/to inclusive. `moneda` es siempre una sola: nunca se suman monedas
// distintas. '' en categoria/canal/banco significa "todas".
export function applyFilters(records, filters) {
  const query = (filters.query ?? '').trim().toLowerCase();
  return records.filter((record) => {
    if (filters.moneda && record.moneda !== filters.moneda) return false;
    if (filters.from && record.fecha < filters.from) return false;
    if (filters.to && record.fecha > filters.to) return false;
    if (filters.categoria && dimValue(record, 'categoria') !== filters.categoria) return false;
    if (filters.canal && dimValue(record, 'canal') !== filters.canal) return false;
    if (filters.banco && dimValue(record, 'banco') !== filters.banco) return false;
    if (filters.hideTransfers && record.categoria === TRANSFER_CATEGORY) return false;
    if (query && !(record.vendor ?? '').toLowerCase().includes(query)) return false;
    return true;
  });
}

// Monedas presentes, de la más usada a la menos. Los registros sin moneda no
// pueden sumarse con nada, así que quedan fuera de las opciones.
export function listCurrencies(records) {
  const counts = new Map();
  for (const record of records) {
    if (!record.moneda) continue;
    counts.set(record.moneda, (counts.get(record.moneda) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([currency]) => currency);
}

// Valores distintos de una dimensión, para llenar los selects de filtro.
export function listValues(records, dim) {
  return [...new Set(records.map((record) => dimValue(record, dim)))].sort((a, b) => a.localeCompare(b, 'es'));
}

// ---------- Colores estables ----------

// Calculado sobre el historial completo (no sobre el filtro activo): así el
// color de una categoría/canal/banco no cambia al filtrar. Devuelve
// Map<valor, espacio 1..MAX_SLOTS>; lo que no figura cae en gris (espacio 0).
export function buildColorMap(records, dim) {
  const counts = new Map();
  for (const record of records) {
    const key = dimValue(record, dim);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const preferred = (PREFERRED_ORDER[dim] ?? []).filter((key) => counts.has(key));
  const rest = [...counts.entries()]
    .filter(([key]) => !preferred.includes(key) && key !== OTHER_KEY && key !== NO_DATA_KEY)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
    .map(([key]) => key);

  const map = new Map();
  [...preferred, ...rest].slice(0, MAX_SLOTS).forEach((key, index) => map.set(key, index + 1));
  return map;
}

export function slotOf(key, colorMap) {
  return colorMap.get(key) ?? 0;
}

// Lo que no tiene color propio se agrupa como "Otros" dentro de una pila.
export function segmentKey(key, colorMap) {
  return slotOf(key, colorMap) > 0 ? key : OTHER_KEY;
}

// ---------- Agregaciones ----------

// Hasta ~2 meses se grafica por día; más allá, por mes (una sola columna
// mensual no dice nada).
export const MAX_DAILY_SPAN = 62;

export function granularityFor({ from, to }) {
  return diffDays(from, to) + 1 <= MAX_DAILY_SPAN ? 'day' : 'month';
}

export function listDays(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

// Totales por mes, con todos los meses del rango (también los vacíos, para que
// un hueco en los datos se vea como hueco). Con `segmentBy`, cada mes trae el
// desglose por esa dimensión.
export function monthlySeries(records, { from, to, segmentBy = null, colorMap = new Map() }) {
  const keys = listMonths(monthOf(from), monthOf(to));
  const series = bucketSeries(records, keys, monthOf, { segmentBy, colorMap });
  return { ...series, rows: series.rows.map((row) => ({ ...row, month: row.key })) };
}

// Igual que monthlySeries pero un bucket por día (rangos cortos).
export function dailySeries(records, { from, to, segmentBy = null, colorMap = new Map() }) {
  return bucketSeries(records, listDays(from, to), (fecha) => fecha, { segmentBy, colorMap });
}

function bucketSeries(records, keys, keyOf, { segmentBy, colorMap }) {
  const rows = keys.map((key) => ({ key, total: 0, count: 0, parts: new Map() }));
  const indexByKey = new Map(keys.map((key, index) => [key, index]));
  const present = new Set();

  for (const record of records) {
    const row = rows[indexByKey.get(keyOf(record.fecha))];
    if (!row) continue;
    const amount = amountOf(record);
    row.total += amount;
    row.count += 1;

    if (segmentBy) {
      const key = segmentKey(dimValue(record, segmentBy), colorMap);
      row.parts.set(key, (row.parts.get(key) ?? 0) + amount);
      present.add(key);
    }
  }

  // Segmentos en orden de color (el mismo de la leyenda y de la pila); "Otros" al final.
  const segments = [...present].sort((a, b) => {
    const slotA = slotOf(a, colorMap) || Infinity;
    const slotB = slotOf(b, colorMap) || Infinity;
    return slotA - slotB;
  });

  return { rows, segments, max: rows.reduce((max, row) => Math.max(max, row.total), 0) };
}

// Ranking por dimensión (categoría, comercio, canal, banco), de mayor a menor.
// Los comercios se agrupan sin distinguir mayúsculas ni espacios repetidos.
export function rankBy(records, dim, { limit } = {}) {
  const groups = new Map();
  let total = 0;

  for (const record of records) {
    const label = dimValue(record, dim);
    const key = dim === 'vendor' ? vendorKey(label) : label;
    const amount = amountOf(record);
    total += amount;

    const group = groups.get(key) ?? { key: label, total: 0, count: 0 };
    group.total += amount;
    group.count += 1;
    groups.set(key, group);
  }

  const rows = [...groups.values()]
    .sort((a, b) => b.total - a.total || b.count - a.count)
    .map((group) => ({ ...group, share: total > 0 ? group.total / total : 0 }));

  return { rows: limit ? rows.slice(0, limit) : rows, total, distinct: rows.length };
}

export function summarize(records) {
  let total = 0;
  let largest = null;
  for (const record of records) {
    total += amountOf(record);
    if (!largest || amountOf(record) > amountOf(largest)) largest = record;
  }
  const count = records.length;
  return { total, count, average: count > 0 ? total / count : 0, largest: count > 0 ? largest : null };
}

// Variación relativa; null si no hay base contra la cual comparar.
export function percentChange(current, previous) {
  return previous > 0 ? (current - previous) / previous : null;
}

// ---------- Suscripciones ----------

export function monthlyEquivalent(subscription) {
  return subscription.frecuencia === 'anual' ? subscription.montoActual / 12 : subscription.montoActual;
}

export function summarizeSubscriptions(subscriptions, moneda, today) {
  const items = subscriptions
    .filter((subscription) => subscription.moneda === moneda)
    .map((subscription) => ({
      ...subscription,
      mensual: monthlyEquivalent(subscription),
      diasParaCobro: diffDays(today, subscription.proximoEstimado),
    }))
    .sort((a, b) => a.diasParaCobro - b.diasParaCobro);

  const mensual = items.reduce((sum, item) => sum + item.mensual, 0);
  return { items, mensual, anual: mensual * 12 };
}

// ---------- Escalas y formato ----------

// Eje Y con números redondos (1, 2, 5 × 10^n) y ~targetTicks divisiones.
export function niceScale(max, targetTicks = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };

  const rough = max / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;

  const divisions = Math.ceil(max / step - 1e-9);
  const ticks = Array.from({ length: divisions + 1 }, (_, index) => Number((index * step).toPrecision(12)));
  return { max: ticks.at(-1), ticks };
}

function trimDecimal(value) {
  return String(Math.round(value * 10) / 10);
}

// Para ticks del eje: 0 / 500 / 1K / 1.5K / 2M.
export function compactNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return String(Math.round(value * 100) / 100);
}

const moneyFormatters = new Map();

export function formatMoney(value, moneda, { decimals = 2 } = {}) {
  const cacheKey = `${moneda}:${decimals}`;
  let formatter = moneyFormatters.get(cacheKey);

  if (formatter === undefined) {
    try {
      formatter = new Intl.NumberFormat('es-PE', {
        style: 'currency',
        currency: moneda,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    } catch {
      formatter = null; // moneda inválida o ausente
    }
    moneyFormatters.set(cacheKey, formatter);
  }

  return formatter ? formatter.format(value) : `${value.toFixed(decimals)} ${moneda ?? ''}`.trim();
}
