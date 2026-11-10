import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeGastos } from '../src/aggregate.js';
import { detectRecurringGroups, filterActiveGroups } from '../src/recurrence.js';

// Fixtures derivados de cobros reales (jul-2025 a ago-2026), con los nombres
// de personas sustituidos por nombres ficticios. Son casos de referencia
// validados a mano (ver docs/arquitectura.md). Sirven para fijar el
// comportamiento del pipeline (dedupe + recurrencia + filtro de activos)
// contra los casos que motivaron cada regla, sin llamar a OpenAI.

const CLAUDE_PRO = [
  // recibo directo (Anthropic, PBC) + cargo de tarjeta (ANTHROPIC* CLAUDE)
  // del mismo cobro en jun/jul/ago — deben fusionarse en dedupeGastos.
  // El "Anthropic" de abril con monto 0 es ruido real de extracción (el
  // correo de bienvenida no menciona el monto) y no debe romper el patrón.
  { emailId: 'c1', es_cobro: true, vendor: 'Anthropic, PBC', monto: 20, moneda: 'USD', fecha: '2026-04-01', canal: 'otro', categoria: 'Suscripciones/Software' },
  { emailId: 'c2', es_cobro: true, vendor: 'Anthropic', monto: 0, moneda: null, fecha: '2026-04-01', canal: 'otro', categoria: 'Suscripciones/Software' },
  { emailId: 'c3', es_cobro: true, vendor: 'Anthropic, PBC', monto: 20, moneda: 'USD', fecha: '2026-05-01', canal: 'otro', categoria: 'Suscripciones/Software' },
  { emailId: 'c4', es_cobro: true, vendor: 'CLAUDE.AI', monto: 20, moneda: 'USD', fecha: '2026-05-01', canal: 'tarjeta', categoria: 'Suscripciones/Software' },
  { emailId: 'c5', es_cobro: true, vendor: 'Anthropic, PBC', monto: 23.6, moneda: 'USD', fecha: '2026-06-01', canal: 'otro', categoria: 'Suscripciones/Software' },
  { emailId: 'c6', es_cobro: true, vendor: 'ANTHROPIC* CLAUDE', monto: 23.6, moneda: 'USD', fecha: '2026-06-01', canal: 'tarjeta', categoria: 'Otros' },
  { emailId: 'c7', es_cobro: true, vendor: 'Anthropic, PBC', monto: 23.6, moneda: 'USD', fecha: '2026-07-01', canal: 'otro', categoria: 'Suscripciones/Software' },
  { emailId: 'c8', es_cobro: true, vendor: 'ANTHROPIC* CLAUDE', monto: 23.6, moneda: 'USD', fecha: '2026-07-01', canal: 'tarjeta', categoria: 'Otros' },
  { emailId: 'c9', es_cobro: true, vendor: 'Anthropic, PBC', monto: 23.6, moneda: 'USD', fecha: '2026-08-04', canal: 'otro', categoria: 'Suscripciones/Software' },
  { emailId: 'c10', es_cobro: true, vendor: 'ANTHROPIC* CLAUDE', monto: 23.6, moneda: 'USD', fecha: '2026-08-04', canal: 'tarjeta', categoria: 'Otros' },
];

const CHATGPT_GO = [
  { emailId: 'g1', es_cobro: true, vendor: 'OPENAI *CHATGPT', monto: 19.9, moneda: 'PEN', fecha: '2026-07-02', canal: 'tarjeta', categoria: 'Suscripciones/Software' },
  { emailId: 'g2', es_cobro: true, vendor: 'OPENAI *CHATGPT', monto: 19.9, moneda: 'PEN', fecha: '2026-08-05', canal: 'tarjeta', categoria: 'Suscripciones/Software' },
];

const SPOTIFY = [
  // "Spotify" con monto 0 en marzo es otro caso de extracción rota (correo
  // sin monto en el texto) con un nombre de vendor distinto al de los
  // cargos de tarjeta reales — no debe contarse ni interferir.
  { emailId: 's0', es_cobro: true, vendor: 'Spotify', monto: 0, moneda: 'PEN', fecha: '2026-03-05', canal: 'otro', categoria: 'Suscripciones/Software' },
  { emailId: 's1', es_cobro: true, vendor: 'EBN*SPOTIFY', monto: 26.9, moneda: 'PEN', fecha: '2026-05-05', canal: 'tarjeta', categoria: 'Suscripciones/Software' },
  { emailId: 's2', es_cobro: true, vendor: 'EBN*SPOTIFY', monto: 26.9, moneda: 'PEN', fecha: '2026-06-05', canal: 'tarjeta', categoria: 'Suscripciones/Software' },
  { emailId: 's3', es_cobro: true, vendor: 'EBN*SPOTIFY', monto: 26.9, moneda: 'PEN', fecha: '2026-07-05', canal: 'tarjeta', categoria: 'Suscripciones/Software' },
  { emailId: 's4', es_cobro: true, vendor: 'EBN*SPOTIFY', monto: 26.9, moneda: 'PEN', fecha: '2026-08-05', canal: 'tarjeta', categoria: 'Suscripciones/Software' },
];

// Google One: 3 cobros mensuales estables y después nada más — la
// suscripción se canceló el 11 de abril de 2026 (confirmado contra Gmail:
// "Tu membresía finalizó"), nunca se cobró de más. Sigue siendo un
// patrón recurrente válido históricamente, pero ya no está activo hoy.
const GOOGLE_ONE_CANCELADA = [
  { emailId: 'go1', es_cobro: true, vendor: 'Google LLC', monto: 5.49, moneda: 'PEN', fecha: '2026-01-11', canal: 'Google Play', categoria: 'Suscripciones/Software' },
  { emailId: 'go2', es_cobro: true, vendor: 'Google LLC', monto: 5.49, moneda: 'PEN', fecha: '2026-02-11', canal: 'Google Play', categoria: 'Suscripciones/Software' },
  { emailId: 'go3', es_cobro: true, vendor: 'Google LLC', monto: 5.49, moneda: 'PEN', fecha: '2026-03-11', canal: 'Google Play', categoria: 'Suscripciones/Software' },
];

// Muestra de ruido Yape/Plin (nombres ficticios): personas distintas, montos que no se
// repiten (y cuando el mismo nombre se repite el mismo día, con montos e
// intervalo — 0 días — que no encajan en el patrón mensual/anual).
const RUIDO_YAPE_PLIN = [
  { emailId: 'y1', es_cobro: true, vendor: 'PERSONA EJEMPLO UNO', monto: 7.5, moneda: 'PEN', fecha: '2026-08-12', canal: 'Plin', categoria: 'Transferencias personales' },
  { emailId: 'y2', es_cobro: true, vendor: 'Comercio Ejemplo S', monto: 20, moneda: 'PEN', fecha: '2026-08-10', canal: 'Plin', categoria: 'Transferencias personales' },
  { emailId: 'y3', es_cobro: true, vendor: 'Persona Ejemplo Dos', monto: 1, moneda: 'PEN', fecha: '2026-08-09', canal: 'Plin', categoria: 'Transferencias personales' },
  { emailId: 'y4', es_cobro: true, vendor: 'Persona Ejemplo Dos', monto: 2.3, moneda: 'PEN', fecha: '2026-08-09', canal: 'Plin', categoria: 'Transferencias personales' },
  { emailId: 'y5', es_cobro: true, vendor: 'Persona Ejemplo Tres', monto: 3, moneda: 'PEN', fecha: '2026-08-08', canal: 'Plin', categoria: 'Transferencias personales' },
  { emailId: 'y6', es_cobro: true, vendor: 'Persona Ejemplo Cuatro', monto: 18.5, moneda: 'PEN', fecha: '2026-08-08', canal: 'Plin', categoria: 'Transferencias personales' },
];

function activeGroups(records, today = new Date('2026-08-19T12:00:00Z')) {
  return filterActiveGroups(detectRecurringGroups(dedupeGastos(records)), { today });
}

test('Claude Pro: recibo directo + cargo de tarjeta se fusionan y detectan como un solo recurrente activo, con el cambio de precio $20->$23.60 sostenido', () => {
  const groups = activeGroups(CLAUDE_PRO);
  assert.equal(groups.length, 1);
  const [claude] = groups;
  assert.equal(claude.moneda, 'USD');
  assert.equal(claude.montoActual, 23.6);
  assert.equal(claude.frecuencia, 'mensual');
  assert.equal(claude.ocurrencias, 5); // abr, may, jun, jul, ago (jun/jul/ago fusionados)
});

test('ChatGPT Go: 2 ocurrencias mensuales se detectan como recurrente activo', () => {
  const groups = activeGroups(CHATGPT_GO);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].vendor, 'OPENAI *CHATGPT');
  assert.equal(groups[0].montoActual, 19.9);
  assert.equal(groups[0].moneda, 'PEN');
});

test('Spotify: el registro roto de monto 0 con otro nombre de vendor no se mezcla ni rompe el patrón real', () => {
  const groups = activeGroups(SPOTIFY);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].vendor, 'EBN*SPOTIFY');
  assert.equal(groups[0].montoActual, 26.9);
  assert.equal(groups[0].ocurrencias, 4);
});

test('Google One cancelada: se detecta como patrón recurrente pero filterActiveGroups la excluye por estar vencida hace meses', () => {
  const deduped = dedupeGastos(GOOGLE_ONE_CANCELADA);
  const detected = detectRecurringGroups(deduped);
  assert.equal(detected.length, 1); // el patrón histórico sigue siendo válido...
  assert.equal(detected[0].vendor, 'Google LLC');

  const active = filterActiveGroups(detected, { today: new Date('2026-08-19T12:00:00Z') });
  assert.equal(active.length, 0); // ...pero no cuenta como "activo hoy"
});

test('ruido Yape/Plin: transferencias a personas distintas (o mismo día, montos distintos) no se marcan como recurrentes', () => {
  const groups = activeGroups(RUIDO_YAPE_PLIN);
  assert.equal(groups.length, 0);
});

// Sintético a propósito: todavía no hay retiros reales en data/gastos.json
// (hasta ahora el extractor los descartaba). Fija que un retiro mensual del
// mismo monto no se anuncie como suscripción.
const RETIROS_MENSUALES = [
  { emailId: 'r1', es_cobro: true, vendor: 'Retiro de efectivo', monto: 200, moneda: 'PEN', fecha: '2026-08-05', canal: 'cajero', categoria: 'Retiros de efectivo' },
  { emailId: 'r2', es_cobro: true, vendor: 'Retiro de efectivo', monto: 200, moneda: 'PEN', fecha: '2026-09-05', canal: 'cajero', categoria: 'Retiros de efectivo' },
  { emailId: 'r3', es_cobro: true, vendor: 'Retiro de efectivo', monto: 200, moneda: 'PEN', fecha: '2026-10-05', canal: 'cajero', categoria: 'Retiros de efectivo' },
];

test('retiros de efectivo: un retiro mensual del mismo monto no se detecta como suscripción', () => {
  assert.equal(detectRecurringGroups(dedupeGastos(RETIROS_MENSUALES, { log: () => {} })).length, 0);

  // Control: con otra categoría el mismo patrón sí es recurrente, así que lo
  // que lo excluye es la categoría y no el monto o las fechas.
  const comoOtraCategoria = RETIROS_MENSUALES.map((record) => ({ ...record, categoria: 'Otros' }));
  assert.equal(detectRecurringGroups(dedupeGastos(comoOtraCategoria, { log: () => {} })).length, 1);
});
