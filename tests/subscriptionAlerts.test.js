import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReminders, checkMissedCharges } from '../src/subscriptionAlerts.js';

// Mismo eje (UTC) que subscriptionAlerts.js, para que "hoy + N días" acá
// coincida exactamente con lo que el módulo bajo prueba considera "hoy".
function isoDateOffset(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const d = new Date(`${todayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function group(overrides = {}) {
  return {
    vendor: 'Netflix',
    moneda: 'PEN',
    montoActual: 45,
    frecuencia: 'mensual',
    proximoEstimado: isoDateOffset(0),
    ...overrides,
  };
}

test('checkReminders dispara a 1 y 2 días antes', () => {
  const groups = [group({ proximoEstimado: isoDateOffset(1) }), group({ vendor: 'Spotify', proximoEstimado: isoDateOffset(2) })];
  const { due } = checkReminders(groups, {});
  assert.equal(due.length, 2);
});

test('checkReminders no dispara fuera de la ventana de 1-2 días', () => {
  const groups = [group({ proximoEstimado: isoDateOffset(0) }), group({ vendor: 'Spotify', proximoEstimado: isoDateOffset(3) })];
  const { due } = checkReminders(groups, {});
  assert.equal(due.length, 0);
});

test('checkReminders no duplica el mismo aviso en corridas sucesivas el mismo día', () => {
  const groups = [group({ proximoEstimado: isoDateOffset(1) })];
  const first = checkReminders(groups, {});
  assert.equal(first.due.length, 1);

  const second = checkReminders(groups, first.state);
  assert.equal(second.due.length, 0);
});

test('checkReminders se vuelve a habilitar cuando proximoEstimado avanza a un nuevo ciclo', () => {
  const cycle1 = group({ vendor: 'Netflix', moneda: 'PEN', proximoEstimado: isoDateOffset(1) });
  const first = checkReminders([cycle1], {});
  assert.equal(first.due.length, 1);

  const repeat = checkReminders([cycle1], first.state);
  assert.equal(repeat.due.length, 0);

  const cycle2 = group({ vendor: 'Netflix', moneda: 'PEN', proximoEstimado: isoDateOffset(2) });
  const second = checkReminders([cycle2], first.state);
  assert.equal(second.due.length, 1);
});

test('checkMissedCharges dispara pasado el día 5 de gracia', () => {
  const groups = [group({ proximoEstimado: isoDateOffset(-6) })];
  const { due } = checkMissedCharges(groups, {});
  assert.equal(due.length, 1);
});

test('checkMissedCharges no dispara antes del día 5 de gracia', () => {
  const groups = [group({ proximoEstimado: isoDateOffset(-4) })];
  const { due } = checkMissedCharges(groups, {});
  assert.equal(due.length, 0);
});

test('checkMissedCharges no duplica el mismo aviso una vez enviado', () => {
  const groups = [group({ proximoEstimado: isoDateOffset(-6) })];
  const first = checkMissedCharges(groups, {});
  assert.equal(first.due.length, 1);

  const second = checkMissedCharges(groups, first.state);
  assert.equal(second.due.length, 0);
});
