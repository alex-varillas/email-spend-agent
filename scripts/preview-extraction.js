// Corre la búsqueda + extracción y muestra un resumen legible, para revisar
// manualmente una muestra antes de ingerir todo el historial.
//
// Cachea los resultados por id de correo en .cache/extractions.json para no
// repetir llamadas pagadas a OpenAI si el script se corta o se vuelve a correr.
//
// Uso: npm run preview -- [cantidad-maxima-de-correos]

import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { searchCandidateEmails, buildSearchQuery } from '../src/gmail.js';
import { extractFromEmail } from '../src/extract.js';

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

const months = Number(process.env.SEARCH_MONTHS) || 12;
const maxResults = Number(process.argv[2]) || 30;

console.log(`Query: ${buildSearchQuery({ months })}`);
console.log(`Buscando hasta ${maxResults} correos candidatos (ventana: ${months} meses)...\n`);

const emails = await searchCandidateEmails({ months, maxResults });
console.log(`Encontrados: ${emails.length} correos candidatos.\n`);

if (emails.length === 0) {
  console.log('No se encontraron correos candidatos. Revisa la query en src/gmail.js.');
  process.exit(0);
}

const cache = await loadCache();
const pending = emails.filter((email) => !cache.has(email.id));
console.log(`En cache: ${emails.length - pending.length} / ${emails.length}. Por extraer: ${pending.length}.\n`);

const results = [];
let processedSinceSave = 0;
let stoppedEarly = false;

try {
  for (const email of emails) {
    if (cache.has(email.id)) {
      results.push(cache.get(email.id));
      continue;
    }

    const result = await extractFromEmail(email);
    cache.set(email.id, result);
    results.push(result);

    processedSinceSave += 1;
    if (processedSinceSave >= 5) {
      await saveCache(cache);
      processedSinceSave = 0;
    }

    // Pausa chica entre llamadas secuenciales para no pegarle tan seguido
    // al límite de tokens por minuto.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
} catch (err) {
  stoppedEarly = true;
  console.error(`\nSe detuvo antes de terminar: ${err.message}`);
  console.error(`Ya quedó cacheado el progreso (${results.length} / ${emails.length} correos). Reintenta más tarde: se retoma donde quedó.\n`);
} finally {
  await saveCache(cache);
}

const cobros = results.filter((result) => result.es_cobro);
console.log(`\nMarcados como cobro real: ${cobros.length} / ${results.length}${stoppedEarly ? ' (corrida incompleta)' : ''}\n`);

for (const result of results) {
  const email = emails.find((candidate) => candidate.id === result.emailId);
  const label = result.es_cobro ? 'COBRO' : 'ruido';
  const detail = result.es_cobro
    ? `${result.vendor} — ${result.monto} ${result.moneda} (${result.canal}) el ${result.fecha}`
    : '(descartado)';

  console.log(`[${label}] ${email.from} | "${email.subject}" -> ${detail}`);
}
