import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  applyFilters,
  buildColorMap,
  compactNumber,
  listCurrencies,
  listMonths,
  monthBounds,
  dailySeries,
  granularityFor,
  monthlySeries,
  niceScale,
  percentChange,
  previousRange,
  rankBy,
  resolveRange,
  segmentKey,
  summarize,
  summarizeSubscriptions,
} from '../src/dashboard/analytics.js';
import { buildDashboardData, handleDashboardRequest } from '../src/dashboard.js';

const gasto = (fecha, vendor, monto, extra = {}) => ({
  es_cobro: true,
  fecha,
  vendor,
  monto,
  moneda: 'PEN',
  canal: 'tarjeta',
  categoria: 'Servicios',
  banco: 'BBVA',
  ...extra,
});

const RECORDS = [
  gasto('2026-06-10', 'Spotify', 20, { categoria: 'Suscripciones/Software' }),
  gasto('2026-07-10', 'Spotify', 20, { categoria: 'Suscripciones/Software' }),
  gasto('2026-07-15', 'Juan Perez', 100, { canal: 'Plin', categoria: 'Transferencias personales', banco: null }),
  gasto('2026-08-01', 'Win Internet', 99.9),
  gasto('2026-08-02', 'Amazon', 15, { moneda: 'USD' }),
  gasto('2026-08-03', 'Sin monto', null, { moneda: null }),
];

async function assetResponse(pathname, { method = 'GET', host = '127.0.0.1' } = {}) {
  const response = {};
  await handleDashboardRequest({ method, headers: { host } }, {
    writeHead(status, headers) { Object.assign(response, { status, headers }); },
    end(body) { response.body = body; },
  }, { pathname });
  return response;
}

test('GSAP y motion se sirven localmente con la CSP estricta y soporte HEAD', async () => {
  for (const path of ['/dashboard/gsap.min.js', '/dashboard/motion.js']) {
    const result = await assetResponse(path);
    assert.equal(result.status, 200);
    assert.equal(result.headers['Content-Type'], 'text/javascript; charset=utf-8');
    assert.ok(result.body.length > 0);
    assert.ok(result.headers['Content-Security-Policy'].includes("script-src 'self'"));
    assert.ok(!result.headers['Content-Security-Policy'].includes('unsafe-'));
    const head = await assetResponse(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
  }
});

test('los archivos de animación siguen rechazando Host ajeno y POST', async () => {
  for (const path of ['/dashboard/gsap.min.js', '/dashboard/motion.js']) {
    assert.equal((await assetResponse(path, { host: 'sitio-ajeno.invalid' })).status, 403);
    assert.equal((await assetResponse(path, { method: 'POST' })).status, 405);
  }
});

test('publicar GSAP no expone directorios, plugins ni mapas del paquete', async () => {
  for (const path of ['/dashboard/gsap.min.js.map', '/dashboard/ScrollTrigger.min.js', '/dashboard/../../.env', '/dashboard/node_modules/gsap/package.json']) {
    assert.equal((await assetResponse(path)).status, 404);
  }
});

test('applyFilters combina rango, moneda, dimensión y búsqueda sin distinguir mayúsculas', () => {
  assert.equal(applyFilters(RECORDS, { moneda: 'PEN' }).length, 4);
  assert.equal(applyFilters(RECORDS, { moneda: 'PEN', from: '2026-07-01', to: '2026-07-31' }).length, 2);
  assert.equal(applyFilters(RECORDS, { moneda: 'PEN', categoria: 'Servicios' }).length, 1);
  assert.equal(applyFilters(RECORDS, { moneda: 'PEN', query: 'SPOT' }).length, 2);
  // banco null se filtra con la etiqueta "Sin dato" que muestra la interfaz
  assert.equal(applyFilters(RECORDS, { moneda: 'PEN', banco: 'Sin dato' }).length, 1);
});

test('hideTransfers saca las transferencias personales', () => {
  const visibles = applyFilters(RECORDS, { moneda: 'PEN', hideTransfers: true });
  assert.equal(visibles.some((r) => r.categoria === 'Transferencias personales'), false);
});

test('nunca se mezclan monedas: un registro sin moneda no entra a ninguna', () => {
  assert.deepEqual(listCurrencies(RECORDS), ['PEN', 'USD']);
  for (const moneda of ['PEN', 'USD']) {
    assert.equal(applyFilters(RECORDS, { moneda }).some((r) => r.moneda === null), false);
  }
});

test('resolveRange: presets relativos a hoy, "todo" desde el primer registro', () => {
  assert.deepEqual(resolveRange('month', '2026-08-20', RECORDS), { from: '2026-08-01', to: '2026-08-20' });
  assert.deepEqual(resolveRange('30', '2026-08-20', RECORDS), { from: '2026-07-22', to: '2026-08-20' });
  assert.deepEqual(resolveRange('all', '2026-08-20', RECORDS), { from: '2026-06-10', to: '2026-08-20' });
  // un rango personalizado invertido se ordena en vez de quedar vacío
  assert.deepEqual(resolveRange('custom', '2026-08-20', [], { from: '2026-08-10', to: '2026-08-01' }), {
    from: '2026-08-01',
    to: '2026-08-10',
  });
});

test('previousRange: mismo largo, inmediatamente antes', () => {
  assert.deepEqual(previousRange({ from: '2026-08-01', to: '2026-08-30' }), { from: '2026-07-02', to: '2026-07-31' });
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('listMonths cruza el cambio de año y monthBounds respeta febrero', () => {
  assert.deepEqual(listMonths('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthBounds('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
});

test('monthlySeries incluye los meses vacíos y suma el desglose', () => {
  const pen = applyFilters(RECORDS, { moneda: 'PEN' });
  const colorMap = buildColorMap(RECORDS, 'categoria');
  const { rows, segments, max } = monthlySeries(pen, {
    from: '2026-05-01',
    to: '2026-08-31',
    segmentBy: 'categoria',
    colorMap,
  });

  assert.deepEqual(rows.map((r) => r.month), ['2026-05', '2026-06', '2026-07', '2026-08']);
  assert.deepEqual(rows.map((r) => r.total), [0, 20, 120, 99.9]);
  assert.equal(rows[2].parts.get('Transferencias personales'), 100);
  assert.equal(max, 120);
  // los segmentos salen en el orden de color: Suscripciones (1) antes que Servicios (2)
  assert.deepEqual(segments, ['Suscripciones/Software', 'Servicios', 'Transferencias personales']);
});

test('el color sigue a la categoría, no al filtro activo', () => {
  const full = buildColorMap(RECORDS, 'categoria');
  const onlyServices = buildColorMap(RECORDS.filter((r) => r.categoria === 'Servicios'), 'categoria');
  // con el historial completo Servicios es el espacio 2; la regla es que se calcula
  // siempre sobre el historial completo, no sobre la tajada filtrada
  assert.equal(full.get('Suscripciones/Software'), 1);
  assert.equal(full.get('Servicios'), 2);
  assert.equal(onlyServices.get('Servicios'), 1);
});

test('más de 7 valores: el resto cae en "Otros" en vez de inventar un color', () => {
  const many = Array.from({ length: 10 }, (_, i) => gasto('2026-08-01', `V${i}`, 1, { banco: `Banco ${i}` }));
  const colorMap = buildColorMap(many, 'banco');
  assert.equal(colorMap.size, 7);
  assert.equal(segmentKey('Banco 9', colorMap), 'Otros');
  assert.equal(segmentKey('Banco 0', colorMap), 'Banco 0');
});

test('rankBy agrupa comercios sin distinguir mayúsculas y ordena por monto', () => {
  const records = [gasto('2026-08-01', 'Culqi *Jumbo', 10), gasto('2026-08-02', 'CULQI *JUMBO', 5), gasto('2026-08-03', 'Otro', 12)];
  const { rows, total, distinct } = rankBy(records, 'vendor');
  assert.equal(distinct, 2);
  assert.equal(total, 27);
  assert.equal(rows[0].total, 15);
  assert.equal(rows[0].count, 2);
  assert.equal(Math.round(rows[0].share * 100), 56);
});

test('summarize y percentChange', () => {
  const s = summarize(applyFilters(RECORDS, { moneda: 'PEN' }));
  assert.equal(s.count, 4);
  assert.equal(s.total, 239.9);
  assert.equal(s.largest.vendor, 'Juan Perez');
  assert.equal(percentChange(150, 100), 0.5);
  assert.equal(percentChange(50, 0), null);
  assert.deepEqual(summarize([]), { total: 0, count: 0, average: 0, largest: null });
});

test('suscripciones: anual se prorratea a mensual y se ordenan por próximo cobro', () => {
  const subs = [
    { vendor: 'Anual', moneda: 'PEN', montoActual: 120, frecuencia: 'anual', proximoEstimado: '2026-09-10' },
    { vendor: 'Mensual', moneda: 'PEN', montoActual: 20, frecuencia: 'mensual', proximoEstimado: '2026-08-25' },
    { vendor: 'Dólares', moneda: 'USD', montoActual: 9, frecuencia: 'mensual', proximoEstimado: '2026-08-22' },
  ];
  const { items, mensual, anual } = summarizeSubscriptions(subs, 'PEN', '2026-08-20');
  assert.deepEqual(items.map((i) => i.vendor), ['Mensual', 'Anual']);
  assert.equal(items[0].diasParaCobro, 5);
  assert.equal(mensual, 30);
  assert.equal(anual, 360);
});

test('niceScale y compactNumber dan números redondos para el eje', () => {
  assert.deepEqual(niceScale(5397).ticks, [0, 2000, 4000, 6000]);
  assert.deepEqual(niceScale(87, 5).ticks, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceScale(87).ticks, [0, 50, 100]);
  assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1] });
  assert.equal(compactNumber(0), '0');
  assert.equal(compactNumber(250), '250');
  assert.equal(compactNumber(1500), '1.5K');
  assert.equal(compactNumber(2000), '2K');
  assert.equal(compactNumber(3_200_000), '3.2M');
});

test('buildDashboardData fusiona recibo+tarjeta, detecta suscripciones vigentes y no filtra campos internos', () => {
  const records = [
    // el mismo cobro llegó por dos correos: se cuenta una vez
    { ...gasto('2026-08-10', 'Anthropic', 20), emailId: 'a1', hora: '2026-08-10T12:30:00Z' },
    { ...gasto('2026-08-10', 'ANTHROPIC PBC', 20), emailId: 'a2', hora: '2026-08-10T13:30:00Z' },
    // suscripción mensual aún vigente
    gasto('2026-06-18', 'Spotify', 20),
    gasto('2026-07-18', 'Spotify', 20),
    gasto('2026-08-18', 'Spotify', 20),
    // suscripción que dejó de cobrarse hace meses
    gasto('2026-01-05', 'Vieja', 10),
    gasto('2026-02-05', 'Vieja', 10),
    gasto('2026-03-05', 'Vieja', 10),
    // no es un cobro
    { ...gasto('2026-08-12', 'Rechazado', 50), es_cobro: false },
  ];

  const data = buildDashboardData(records, { today: new Date('2026-08-20T12:00:00Z') });

  assert.equal(data.gastos.filter((g) => g.vendor.toLowerCase().includes('anthropic')).length, 1);
  assert.equal(data.gastos.some((g) => g.vendor === 'Rechazado'), false);
  assert.deepEqual(data.suscripciones.map((s) => s.vendor), ['Spotify']);
  assert.equal(data.ultimaFecha, '2026-08-18');
  assert.deepEqual(Object.keys(data.gastos[0]).sort(), ['banco', 'canal', 'categoria', 'fecha', 'hora', 'moneda', 'monto', 'vendor']);
  assert.equal(data.gastos.find((g) => g.vendor === 'ANTHROPIC PBC').hora, '2026-08-10T13:30:00Z');
  assert.equal(data.gastos.some((g) => 'emailId' in g), false);
});

test('rangos cortos se grafican por día y largos por mes', () => {
  assert.equal(granularityFor({ from: '2026-08-01', to: '2026-08-20' }), 'day');
  assert.equal(granularityFor({ from: '2026-07-01', to: '2026-08-31' }), 'day'); // 62 días
  assert.equal(granularityFor({ from: '2026-06-30', to: '2026-08-31' }), 'month'); // 63 días

  const pen = applyFilters(RECORDS, { moneda: 'PEN' });
  const { rows, max } = dailySeries(pen, { from: '2026-07-09', to: '2026-07-16' });
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.filter((r) => r.total > 0).map((r) => [r.key, r.total]), [['2026-07-10', 20], ['2026-07-15', 100]]);
  assert.equal(max, 100);
});
