import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DATA_DIR = new URL('../data/', import.meta.url);

// Sin userId, usa el store global del usuario único (comportamiento
// original). Con userId, cada usuario conectado vía el bot tiene su propio
// archivo, aislado del resto.
function storeFile(userId) {
  return userId ? new URL(`users/${userId}/gastos.json`, DATA_DIR) : new URL('gastos.json', DATA_DIR);
}

function storeDir(userId) {
  return userId ? new URL(`users/${userId}/`, DATA_DIR) : DATA_DIR;
}

export async function loadStore(userId) {
  try {
    const raw = await readFile(storeFile(userId), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function saveStore(records, userId) {
  await mkdir(storeDir(userId), { recursive: true });
  await writeFile(storeFile(userId), JSON.stringify(records, null, 2));
}

// Guarda o actualiza gastos por emailId, para poder re-ingestar sin duplicar.
export async function upsertGastos(newRecords, userId) {
  const existing = await loadStore(userId);
  const byId = new Map(existing.map((record) => [record.emailId, record]));

  for (const record of newRecords) {
    byId.set(record.emailId, record);
  }

  const merged = [...byId.values()];
  await saveStore(merged, userId);
  return merged;
}

// Filtra gastos reales (es_cobro true) dentro de un rango de fechas
// [from, to] inclusive, en formato YYYY-MM-DD (comparación lexicográfica,
// válida porque el formato es siempre YYYY-MM-DD). from/to/categoria opcionales.
export function filterGastos(records, { from, to, categoria } = {}) {
  return records.filter((record) => {
    if (!record.es_cobro || !record.fecha) return false;
    if (from && record.fecha < from) return false;
    if (to && record.fecha > to) return false;
    if (categoria && record.categoria !== categoria) return false;
    return true;
  });
}
