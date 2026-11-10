const CARD_CHANNEL = 'tarjeta';

// Los retiros de efectivo cuentan como gasto (sale plata de la cuenta), pero
// no son un pago a un comercio: recurrence.js los deja fuera de las
// suscripciones.
export const CASH_WITHDRAWAL_CATEGORY = 'Retiros de efectivo';

// Prefijos/palabras genéricas de bancos y procesadores que no identifican al
// comercio real, para que no generen falsos positivos de duplicado.
const GENERIC_TOKENS = new Set(['WEB', 'QR', 'BCP', 'BBVA', 'IZI', 'CULQI', 'PAGO', 'COMPRA', 'CONSUMO', 'TARJETA']);

export function normalizeVendor(vendor) {
  return (vendor ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function vendorTokens(vendor) {
  return normalizeVendor(vendor)
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token));
}

function vendorsOverlap(a, b) {
  const tokensA = vendorTokens(a);
  const tokensB = vendorTokens(b);
  if (tokensA.length > 0 && tokensB.length > 0) {
    return tokensA.some((token) => tokensB.includes(token));
  }

  // Fallback para vendors muy cortos (ej. "X" de Twitter/X Corp), que el
  // filtro de largo mínimo (>=4) deja sin tokens: si el más corto es una
  // palabra completa dentro del otro, cuenta como el mismo vendor.
  const [shortRaw, longRaw] = normalizeVendor(a).length <= normalizeVendor(b).length ? [a, b] : [b, a];
  const shortWord = normalizeVendor(shortRaw).replace(/[^A-Z0-9]/g, '');
  if (!shortWord || shortWord.length > 3) return false;

  const longWords = normalizeVendor(longRaw)
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return longWords.includes(shortWord);
}

// Un mismo cobro puede llegar reportado dos veces: el recibo directo del
// vendor y el aviso de consumo de tarjeta del banco/procesador. Si coinciden
// en fecha, monto y moneda, y al menos uno es un cargo de tarjeta, y los
// nombres de vendor comparten una palabra significativa, es el mismo cobro
// real — se combinan en un solo registro.
export function dedupeGastos(records, { log = console.log } = {}) {
  const used = new Array(records.length).fill(false);
  const result = [];

  for (let i = 0; i < records.length; i++) {
    if (used[i]) continue;
    let best = records[i];
    used[i] = true;

    for (let j = i + 1; j < records.length; j++) {
      if (used[j]) continue;
      const other = records[j];

      const sameDay = best.fecha === other.fecha;
      const sameAmount = Math.abs((best.monto ?? 0) - (other.monto ?? 0)) < 0.01;
      const sameCurrency = best.moneda === other.moneda;
      const involvesCard = best.canal === CARD_CHANNEL || other.canal === CARD_CHANNEL;

      if (sameDay && sameAmount && sameCurrency && involvesCard && vendorsOverlap(best.vendor, other.vendor)) {
        used[j] = true;

        const preferOther =
          (best.canal === CARD_CHANNEL && other.canal !== CARD_CHANNEL) ||
          (best.canal === other.canal && (other.vendor?.length ?? 0) > (best.vendor?.length ?? 0));

        log(
          `  Duplicado detectado: "${best.vendor}" + "${other.vendor}" (${best.monto} ${best.moneda} el ${best.fecha}) -> se combinan`
        );

        if (preferOther) best = other;
      }
    }

    result.push(best);
  }

  return result;
}

// Agrupa por vendor normalizado + moneda (un vendor recurrente siempre
// cobra en la misma moneda; si aparece en dos, son patrones distintos).
export function groupByVendor(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${normalizeVendor(record.vendor)}::${record.moneda}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}
