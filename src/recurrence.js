import { groupByVendor, CASH_WITHDRAWAL_CATEGORY } from './aggregate.js';

const MONTHLY_MIN_DAYS = 25;
const MONTHLY_MAX_DAYS = 35;
const ANNUAL_MIN_DAYS = 350;
const ANNUAL_MAX_DAYS = 380;
const AMOUNT_TOLERANCE = 0.05; // 5%, para variaciones de impuestos

// Mismo umbral que MISSED_CHARGE_GRACE_DAYS en subscriptionAlerts.js: pasados
// 5 días del proximoEstimado sin un cobro nuevo, se asume cancelada.
const ACTIVE_GRACE_DAYS = 5;

function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 86_400_000;
}

function isRegularInterval(days) {
  return (
    (days >= MONTHLY_MIN_DAYS && days <= MONTHLY_MAX_DAYS) || (days >= ANNUAL_MIN_DAYS && days <= ANNUAL_MAX_DAYS)
  );
}

function classifyFrequency(avgDays) {
  if (avgDays >= MONTHLY_MIN_DAYS && avgDays <= MONTHLY_MAX_DAYS) return 'mensual';
  if (avgDays >= ANNUAL_MIN_DAYS && avgDays <= ANNUAL_MAX_DAYS) return 'anual';
  return null;
}

function amountsCompatible(a, b) {
  if (!a || !b) return false;
  return Math.abs(a - b) / Math.max(a, b) <= AMOUNT_TOLERANCE;
}

// Detecta si la secuencia de montos (ordenada por fecha) es estable, o tiene
// un único cambio que después se sostiene (caso Google One: 3x S/5.49 y
// luego sostenido a S/17.99 — sigue siendo el mismo patrón recurrente).
//
// Un cambio en la ÚLTIMA ocurrencia no cuenta como "sostenido" todavía —
// necesita al menos una ocurrencia más al nuevo precio para confirmarlo.
// Sin este requisito, cualquier par de montos distintos con solo 2
// ocurrencias pasaría trivialmente (un solo cambio posible en una serie de
// largo 2), lo que en la práctica dejaba pasar falsos positivos: compras
// puntuales en la misma tienda o transferencias a la misma persona por
// montos distintos, que coincidieron en caer ~30 días aparte.
function hasStableOrSustainedPriceChange(amounts) {
  if (amounts.length < 2) return true;

  let baseline = amounts[0];
  let changeIndex = -1;

  for (let i = 1; i < amounts.length; i++) {
    if (amountsCompatible(amounts[i], baseline)) continue;

    if (changeIndex === -1) {
      changeIndex = i;
      baseline = amounts[i];
      continue;
    }

    return false; // segundo quiebre sin patrón: no calza como recurrente simple
  }

  if (changeIndex === -1) return true; // nunca cambió
  return changeIndex < amounts.length - 1; // el cambio no puede ser la última ocurrencia
}

// Marca como recurrente un grupo (mismo vendor + moneda) con 2+ ocurrencias,
// intervalo regular (mensual o anual, con tolerancia) y monto estable o con
// un único cambio sostenido. Ver docs/arquitectura.md para las reglas.
// Los retiros de efectivo se excluyen: un retiro mensual del mismo monto es un
// hábito, no una suscripción, y no debe disparar avisos de "nueva suscripción".
export function detectRecurringGroups(records) {
  const groups = groupByVendor(records.filter((record) => record.categoria !== CASH_WITHDRAWAL_CATEGORY));
  const recurring = [];

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;

    const sorted = [...entries].sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(sorted[i - 1].fecha, sorted[i].fecha));
    }

    const regularCount = intervals.filter(isRegularInterval).length;
    // Con un solo intervalo, tiene que ser regular. Con más, toleramos que
    // la mayoría lo sea (correos que llegan un poco antes/después).
    const isRegular = intervals.length === 1 ? regularCount === 1 : regularCount / intervals.length >= 0.6;
    if (!isRegular) continue;

    const amounts = sorted.map((entry) => entry.monto);
    if (!hasStableOrSustainedPriceChange(amounts)) continue;

    const regularIntervals = intervals.filter(isRegularInterval);
    const avgInterval = regularIntervals.reduce((sum, days) => sum + days, 0) / regularIntervals.length;
    const frequency = classifyFrequency(avgInterval);
    if (!frequency) continue;

    const last = sorted[sorted.length - 1];
    const nextEstimatedDate = new Date(last.fecha);
    nextEstimatedDate.setDate(nextEstimatedDate.getDate() + Math.round(avgInterval));

    recurring.push({
      vendor: last.vendor,
      moneda: last.moneda,
      montoActual: last.monto,
      frecuencia: frequency,
      ultimoCobro: last.fecha,
      proximoEstimado: nextEstimatedDate.toISOString().slice(0, 10),
      categoria: last.categoria,
      ocurrencias: sorted.length,
      historial: sorted.map((entry) => ({ fecha: entry.fecha, monto: entry.monto })),
    });
  }

  return recurring;
}

// Mismas fechas YYYY-MM-DD que el resto del proyecto, comparadas en UTC
// (ver el comentario equivalente en subscriptionAlerts.js) para no meter un
// desfase de día por timezone local.
function daysFromToday(dateStr, today) {
  const todayStr = today.toISOString().slice(0, 10);
  const t = new Date(`${todayStr}T00:00:00Z`);
  const target = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((target - t) / 86_400_000);
}

// detectRecurringGroups marca un patrón como recurrente aunque ya se haya
// cortado (el poller.js necesita verlo así para poder avisar "posible
// cancelación" justo cuando cruza el umbral). Para mostrarle al usuario qué
// sigue pagando HOY (reportes, /suscripciones), hay que filtrar los grupos
// cuyo proximoEstimado ya pasó el mismo umbral de gracia sin renovarse.
export function filterActiveGroups(groups, { today = new Date() } = {}) {
  return groups.filter((group) => daysFromToday(group.proximoEstimado, today) > -ACTIVE_GRACE_DAYS);
}
