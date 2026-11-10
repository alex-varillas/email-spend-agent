import { searchCandidateEmails } from './gmail.js';
import { extractFromEmail } from './extract.js';
import { upsertGastos } from './store.js';

// Escaneo inicial de 12 meses para un usuario recién conectado (una sola
// vez). Después de esto, poll-users.js se encarga de las novedades con una
// ventana chica (barato, no vuelve a tocar todo el historial).
//
// `onProgress(processed, total, percent)`, si se pasa, se llama una vez por
// cada umbral de 25% cruzado (25/50/75 — no 100, para no pisar el mensaje
// de "listo" que manda el caller apenas termina). Pensado para que el bot
// pueda avisar por Telegram que el backfill sigue en curso, no que se colgó.
export async function backfillUser({ oauth, userId, months = 12, maxResults = 2000, batchSize = 5, delayMs = 400, onProgress }) {
  const emails = await searchCandidateEmails({ months, maxResults, auth: oauth });
  const results = [];
  const total = emails.length;
  let notifiedThreshold = 0;

  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((email) => extractFromEmail(email)));
    results.push(...batchResults);

    const processed = Math.min(i + batchSize, total);
    const percent = total > 0 ? Math.floor((processed / total) * 100) : 100;
    if (percent >= notifiedThreshold + 25 && percent < 100) {
      notifiedThreshold = Math.floor(percent / 25) * 25;
      await onProgress?.(processed, total, notifiedThreshold);
    }

    if (i + batchSize < emails.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const gastos = results.filter((result) => result.es_cobro);
  await upsertGastos(gastos, userId);

  return { totalCorreos: emails.length, gastosEncontrados: gastos.length };
}
