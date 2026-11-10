// Ingesta real: busca correos, extrae, y persiste los gastos reales en
// data/gastos.json. A diferencia de preview-extraction.js (que es para
// revisar una muestra a mano), este script guarda el resultado para que el
// bot y los reportes lo consulten sin tener que re-escanear Gmail cada vez.
//
// Cachea cada extracción por id de correo en .cache/extractions.json, así
// que se puede volver a correr sin re-pagar/re-esperar por correos ya
// procesados si se corta a la mitad.
//
// Uso: npm run ingest -- [meses] [maxResults]

import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { searchCandidateEmails, buildSearchQuery } from '../src/gmail.js';
import { extractFromEmail } from '../src/extract.js';
import { upsertGastos } from '../src/store.js';

const CACHE_DIR = new URL('../.cache/', import.meta.url);
const CACHE_FILE = new URL('extractions.json', CACHE_DIR);

async function loadCache() {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

async function saveCache(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache), null, 2));
}

const months = Number(process.argv[2]) || 12;
const maxResults = Number(process.argv[3]) || 4000;
const batchSize = 5;
const delayMs = 300;

console.log(`Query: ${buildSearchQuery({ months })}`);
console.log(`Buscando hasta ${maxResults} correos candidatos (ventana: ${months} meses)...\n`);

const emails = await searchCandidateEmails({ months, maxResults });
console.log(`Encontrados: ${emails.length} correos candidatos.\n`);

const cache = await loadCache();
const pending = emails.filter((email) => !cache.has(email.id));
console.log(`En cache: ${emails.length - pending.length} / ${emails.length}. Por extraer: ${pending.length}.\n`);

let stoppedEarly = false;

try {
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((email) => extractFromEmail(email)));
    for (const result of batchResults) cache.set(result.emailId, result);
    await saveCache(cache);

    if ((i / batchSize) % 10 === 0) {
      console.log(`  Procesados ${Math.min(i + batchSize, pending.length)} / ${pending.length}...`);
    }

    if (i + batchSize < pending.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
} catch (err) {
  stoppedEarly = true;
  console.error(`\nSe detuvo antes de terminar: ${err.message}`);
  console.error('El progreso ya quedó cacheado, se puede reintentar más tarde.\n');
} finally {
  await saveCache(cache);
}

const allResults = emails.map((email) => cache.get(email.id)).filter(Boolean);
const gastosReales = allResults.filter((result) => result.es_cobro);

console.log(`\nTotal procesados: ${allResults.length} / ${emails.length}${stoppedEarly ? ' (corrida incompleta)' : ''}.`);
console.log(`Gastos reales encontrados en esta corrida: ${gastosReales.length}.`);

const stored = await upsertGastos(gastosReales);
console.log(`Guardados en data/gastos.json. Total histórico en el store: ${stored.length}.`);
