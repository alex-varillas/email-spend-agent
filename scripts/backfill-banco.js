// Migración de una sola vez: agrega el campo "banco" a los gastos ya
// guardados (extraídos antes de que existiera ese campo). No usa el LLM —
// solo vuelve a pedir el remitente de cada correo a Gmail (gratis, rápido)
// y aplica el mismo detector de banco que ya usa extract.js.
//
// Uso: npm run backfill-banco

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { google } from 'googleapis';
import { getOAuthClient } from '../src/gmail.js';

const BANK_PATTERNS = [
  { pattern: /bbva/i, name: 'BBVA' },
  { pattern: /bcp|viabcp/i, name: 'BCP' },
  { pattern: /interbank/i, name: 'Interbank' },
  { pattern: /scotiabank/i, name: 'Scotiabank' },
  { pattern: /izipay/i, name: 'izipay' },
  { pattern: /culqi/i, name: 'Culqi' },
  { pattern: /bancodelanacion|banconacion/i, name: 'Banco de la Nación' },
  { pattern: /niubiz|visanet/i, name: 'Niubiz' },
];

function detectBanco(from) {
  if (!from) return null;
  const match = BANK_PATTERNS.find(({ pattern }) => pattern.test(from));
  return match?.name ?? null;
}

async function fetchFromHeader(gmail, id) {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'metadata',
    metadataHeaders: ['From'],
  });
  return data.payload?.headers?.find((h) => h.name === 'From')?.value ?? null;
}

async function backfillStoreFile(path, gmail) {
  const store = JSON.parse(await readFile(path, 'utf-8'));
  const pending = store.filter((record) => !('banco' in record));
  console.log(`${path}: ${store.length} registros, ${pending.length} sin banco.`);

  const batchSize = 10;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (record) => {
        const from = await fetchFromHeader(gmail, record.emailId);
        record.banco = detectBanco(from);
      })
    );
  }

  await writeFile(path, JSON.stringify(store, null, 2));
  console.log(`${path}: listo.`);
}

const auth = getOAuthClient();
const gmail = google.gmail({ version: 'v1', auth });

await backfillStoreFile(new URL('../data/gastos.json', import.meta.url), gmail);

// También actualiza el cache de extracciones, para que un futuro `npm run
// ingest` no pise el store con versiones viejas (sin banco) desde el cache.
const cachePath = new URL('../.cache/extractions.json', import.meta.url);
try {
  const cache = JSON.parse(await readFile(cachePath, 'utf-8'));
  const ids = Object.keys(cache).filter((id) => !('banco' in cache[id]));
  console.log(`Cache: ${Object.keys(cache).length} entradas, ${ids.length} sin banco.`);

  const batchSize = 10;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (id) => {
        const from = await fetchFromHeader(gmail, id);
        cache[id].banco = detectBanco(from);
      })
    );
  }

  await writeFile(cachePath, JSON.stringify(cache, null, 2));
  console.log('Cache: listo.');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
