import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DATA_DIR = new URL('../data/', import.meta.url);

function seenFile(userId) {
  return userId ? new URL(`users/${userId}/seen-emails.json`, DATA_DIR) : new URL('seen-emails.json', DATA_DIR);
}

function seenDir(userId) {
  return userId ? new URL(`users/${userId}/`, DATA_DIR) : DATA_DIR;
}

// IDs de correos ya procesados por el poller, sin importar en qué
// terminaron clasificados (gasto real, intento fallido, o puro ruido). Los
// gastos e intentos fallidos ya quedan registrados en gastos.json, pero el
// ruido (newsletters, boletines, cualquier correo candidato que no resultó
// ser un cobro) no queda guardado en ningún lado — sin esto, el poller
// se lo vuelve a mandar a OpenAI en cada ciclo mientras siga dentro de la
// ventana de POLL_WINDOW_DAYS, pagando de nuevo por clasificar lo mismo.
export async function loadSeenEmailIds(userId) {
  try {
    const raw = await readFile(seenFile(userId), 'utf-8');
    return new Set(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

// No se podan los ids viejos a propósito: un id más antiguo que
// POLL_WINDOW_DAYS nunca lo vuelve a traer la búsqueda de todos modos, así
// que queda inerte. El archivo crece unos pocos KB por año (cada id son
// ~20 bytes), no justifica la complejidad de limpiarlo.
export async function addSeenEmailIds(newIds, userId) {
  if (newIds.length === 0) return;
  const existing = await loadSeenEmailIds(userId);
  for (const id of newIds) existing.add(id);
  await mkdir(seenDir(userId), { recursive: true });
  await writeFile(seenFile(userId), JSON.stringify([...existing]));
}
