// Estado persistido para dos avisos que dependen de la fecha de hoy, no de
// correos nuevos: recordatorio de cobro próximo, y "probablemente
// cancelaste" cuando pasa la fecha esperada sin que llegue el cobro. Mismo
// patrón de archivo plano por usuario que store.js.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { normalizeVendor } from './aggregate.js';

const DATA_DIR = new URL('../data/', import.meta.url);

const REMINDER_DAYS_BEFORE = [1, 2];
const MISSED_CHARGE_GRACE_DAYS = 5;

function stateFile(userId) {
  return userId ? new URL(`users/${userId}/subscription-alerts.json`, DATA_DIR) : new URL('subscription-alerts.json', DATA_DIR);
}

function stateDir(userId) {
  return userId ? new URL(`users/${userId}/`, DATA_DIR) : DATA_DIR;
}

export async function loadAlertState(userId) {
  try {
    const raw = await readFile(stateFile(userId), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveAlertState(state, userId) {
  await mkdir(stateDir(userId), { recursive: true });
  await writeFile(stateFile(userId), JSON.stringify(state, null, 2));
}

function groupKey(group) {
  return `${normalizeVendor(group.vendor)}::${group.moneda}`;
}

// Todas las fechas del proyecto (fecha, proximoEstimado) son strings
// YYYY-MM-DD generadas vía toISOString().slice(0, 10) — se comparan acá en
// el mismo eje (UTC) para no meter un desfase de día por timezone local al
// mezclar new Date() (hora local) con new Date(dateStr) (medianoche UTC).
function daysFromToday(dateStr) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = new Date(`${todayStr}T00:00:00Z`);
  const target = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

// Suscripciones a 1-2 días de su próximo cobro estimado que todavía no
// tuvieron recordatorio para esa fecha puntual. La clave del estado incluye
// el valor de proximoEstimado, así que cuando el ciclo avanza (llegó un
// cobro nuevo y se recalculó la fecha), el recordatorio se vuelve a
// habilitar solo, sin lógica de limpieza aparte.
export function checkReminders(groups, state) {
  const due = [];
  const nextState = { ...state };

  for (const group of groups) {
    const key = groupKey(group);
    const diff = daysFromToday(group.proximoEstimado);
    if (!REMINDER_DAYS_BEFORE.includes(diff)) continue;
    if (nextState[key]?.reminderSentFor === group.proximoEstimado) continue;

    due.push({ ...group, diasRestantes: diff });
    nextState[key] = { ...nextState[key], reminderSentFor: group.proximoEstimado };
  }

  return { due, state: nextState };
}

// Suscripciones cuya fecha esperada de cobro ya pasó hace más de
// MISSED_CHARGE_GRACE_DAYS sin que llegara un cobro nuevo (si hubiera
// llegado, recurrence.js ya habría recalculado proximoEstimado a futuro).
export function checkMissedCharges(groups, state) {
  const due = [];
  const nextState = { ...state };

  for (const group of groups) {
    const key = groupKey(group);
    const diff = daysFromToday(group.proximoEstimado);
    if (diff > -MISSED_CHARGE_GRACE_DAYS) continue;
    if (nextState[key]?.missedAlertSentFor === group.proximoEstimado) continue;

    due.push(group);
    nextState[key] = { ...nextState[key], missedAlertSentFor: group.proximoEstimado };
  }

  return { due, state: nextState };
}
