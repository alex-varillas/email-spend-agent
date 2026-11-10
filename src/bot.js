import Groq from 'groq-sdk';
import { loadStore, filterGastos } from './store.js';
import { dedupeGastos, normalizeVendor } from './aggregate.js';
import { detectRecurringGroups, filterActiveGroups } from './recurrence.js';
import { generateGastosExcel } from './excel.js';
import { sendTelegramMessage, sendTelegramDocument } from './telegram.js';
import { buildUsageExamplesText } from './messages.js';

const API_BASE = 'https://api.telegram.org';

const INTENT_SYSTEM_PROMPT = `Interpretás mensajes de un bot de gastos personales. Dado el mensaje del usuario y la fecha de hoy, devolvés SOLO un JSON (sin texto adicional) con:

{
  "tipo": "gastos" | "suscripciones" | "otro",
  "desde": "YYYY-MM-DD" o null,
  "hasta": "YYYY-MM-DD" o null
}

Reglas:
- "gastos" es cuando pregunta por todo tipo de gasto o movimiento de dinero (compras, transferencias, todo).
- "suscripciones" es cuando pregunta específicamente por suscripciones, cobros recurrentes, o "lo que pago cada mes".
- "otro" si el mensaje no es una consulta de gastos (saludo, algo no relacionado) — ahí desde/hasta van null.
- Si no menciona un período, "desde" y "hasta" van null.
- "los últimos N días" -> desde = hoy menos N días, hasta = hoy.
- Un mes por nombre (ej "agosto") -> el día 1 y el último día de ese mes, año actual salvo que diga otro año.
- "este mes" -> el mes en curso, pero "hasta" nunca puede ser una fecha futura: si hoy es 2026-08-12, "este mes" es del 01 al 12, no hasta el 31.`;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const to = lastDayOfMonth < now ? lastDayOfMonth : now;
  return { desde: from.toISOString().slice(0, 10), hasta: to.toISOString().slice(0, 10) };
}

// Bot de uso personal: el único chat autorizado es TELEGRAM_CHAT_ID (.env).
// Sin esa variable no se autoriza a nadie.
function isOwner(chatId) {
  const ownerChatId = process.env.TELEGRAM_CHAT_ID;
  return Boolean(ownerChatId) && String(chatId) === String(ownerChatId);
}

let groqClient;
function getGroq() {
  if (!groqClient) {
    const { GROQ_API_KEY } = process.env;
    if (!GROQ_API_KEY) throw new Error('Falta GROQ_API_KEY en .env (usado para el bot conversacional).');
    groqClient = new Groq({ apiKey: GROQ_API_KEY });
  }
  return groqClient;
}

export async function interpretMessage(text) {
  const groq = getGroq();
  const model = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-20b';

  const completion = await groq.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: `Hoy es ${todayStr()}. Mensaje: "${text}"` },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { tipo: 'otro', desde: null, hasta: null };
  }
}

function formatMoney(amount, currency) {
  return `${Number(amount).toFixed(2)} ${currency}`;
}

export async function handleGastos({ desde, hasta, userId }) {
  const store = await loadStore(userId);
  // Deduplicar antes de filtrar por fecha: el mismo cobro puede llegar por
  // dos correos (recibo directo + aviso de tarjeta), y sin esto se cuenta
  // y se lista dos veces en el detalle general.
  const deduped = dedupeGastos(store.filter((record) => record.es_cobro));
  const filtered = filterGastos(deduped, { from: desde, to: hasta });

  if (filtered.length === 0) {
    return { text: `No encontré gastos entre ${desde} y ${hasta}.` };
  }

  // Recurrencia se calcula sobre TODO el historial (necesita meses de data
  // para confirmar un patrón), no solo sobre el rango pedido. Después se
  // cruza contra los movimientos del rango para ver cuánto de eso es
  // suscripción conocida.
  const recurringGroups = detectRecurringGroups(deduped);
  const recurringKeys = new Set(recurringGroups.map((group) => `${normalizeVendor(group.vendor)}::${group.moneda}`));

  const totals = new Map();
  const porCategoria = new Map();
  const recurringTotals = new Map();
  let recurringCount = 0;

  for (const record of filtered) {
    totals.set(record.moneda, (totals.get(record.moneda) ?? 0) + record.monto);
    const catKey = `${record.categoria ?? 'Otros'}::${record.moneda}`;
    porCategoria.set(catKey, (porCategoria.get(catKey) ?? 0) + record.monto);

    const vendorKey = `${normalizeVendor(record.vendor)}::${record.moneda}`;
    if (recurringKeys.has(vendorKey)) {
      recurringCount += 1;
      recurringTotals.set(record.moneda, (recurringTotals.get(record.moneda) ?? 0) + record.monto);
    }
  }

  const lines = [
    `<b>Gastos del ${desde} al ${hasta}</b>`,
    `Movimientos: ${filtered.length} (todo tipo de gasto detectado en tus correos, duplicados ya combinados)`,
    '',
  ];

  lines.push('<b>Total general:</b>');
  for (const [moneda, total] of totals) lines.push(`  ${formatMoney(total, moneda)}`);
  lines.push('');

  lines.push('<b>Por categoría:</b>');
  for (const [key, total] of porCategoria) {
    const [categoria, moneda] = key.split('::');
    lines.push(`  ${categoria}: ${formatMoney(total, moneda)}`);
  }
  lines.push('');

  lines.push('<b>De esto, recurrente (suscripciones conocidas):</b>');
  if (recurringCount > 0) {
    lines.push(`  ${recurringCount} de ${filtered.length} movimientos`);
    for (const [moneda, total] of recurringTotals) lines.push(`  ${formatMoney(total, moneda)}`);
    lines.push('  (usá /suscripciones para el detalle de cada una)');
  } else {
    lines.push('  Ninguno en este período.');
  }
  lines.push('');
  lines.push('Detalle completo (correo, hora, monto, canal, categoría) en el Excel adjunto.');

  const excelBuffer = await generateGastosExcel(filtered);
  return { text: lines.join('\n'), excelBuffer, excelName: `gastos_${desde}_${hasta}.xlsx` };
}

export async function handleSuscripciones({ desde, hasta, userId }) {
  const store = await loadStore(userId);
  const deduped = dedupeGastos(store.filter((record) => record.es_cobro));
  // Solo lo que sigue activo hoy — detectRecurringGroups también devuelve
  // patrones que ya se cortaron (necesario para que poller.js pueda avisar
  // "posible cancelación"), pero acá el usuario está preguntando qué le
  // siguen cobrando, no su historial completo.
  const recurring = filterActiveGroups(detectRecurringGroups(deduped));

  const filtered =
    desde && hasta ? recurring.filter((group) => group.ultimoCobro >= desde && group.ultimoCobro <= hasta) : recurring;

  if (filtered.length === 0) {
    return { text: 'No tengo suscripciones o cobros recurrentes detectados en ese período.' };
  }

  const lines = ['<b>Suscripciones y cobros recurrentes:</b>', ''];
  for (const group of filtered) {
    lines.push(
      `• ${group.vendor} — ${formatMoney(group.montoActual, group.moneda)} (${group.frecuencia}) — ` +
        `próximo estimado: ${group.proximoEstimado}`
    );
  }

  return { text: lines.join('\n') };
}

export async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;

  // Cualquier otro chat se ignora en silencio: ni respuesta ni su texto en el
  // log (el bot se puede encontrar buscándolo en Telegram).
  if (!isOwner(chatId)) {
    console.log(`[bot] mensaje ignorado de un chat no autorizado (${chatId})`);
    return;
  }

  const text = message.text.trim();
  console.log(`[bot] mensaje de ${chatId}: "${text}"`);

  if (text.startsWith('/start')) {
    await sendTelegramMessage(`Ya tenés tu Gmail conectado.\n\n${buildUsageExamplesText()}`, { chatId });
    return;
  }

  let intent;
  if (text.startsWith('/gastos')) {
    intent = { tipo: 'gastos', desde: null, hasta: null };
  } else if (text.startsWith('/suscripciones')) {
    intent = { tipo: 'suscripciones', desde: null, hasta: null };
  } else if (text.startsWith('/')) {
    await sendTelegramMessage(buildUsageExamplesText(), { chatId });
    return;
  } else {
    intent = await interpretMessage(text);
  }

  if (intent.tipo === 'otro') {
    await sendTelegramMessage(
      'No entendí bien. Probá algo como "dame los gastos de los últimos 15 días" o "muéstrame mis suscripciones".',
      { chatId }
    );
    return;
  }

  const defaultRange = currentMonthRange();
  const desde = intent.desde ?? defaultRange.desde;
  // Nunca mostrar un "hasta" en el futuro (ej. "este mes" no debería decir
  // hasta el día 31 si hoy es 12) — ni el default ni lo que interprete Groq.
  const hasta = (intent.hasta ?? defaultRange.hasta) > todayStr() ? todayStr() : intent.hasta ?? defaultRange.hasta;

  const handler = intent.tipo === 'suscripciones' ? handleSuscripciones : handleGastos;
  const result = await handler({ desde, hasta });

  await sendTelegramMessage(result.text, { chatId });
  if (result.excelBuffer) {
    await sendTelegramDocument(result.excelBuffer, result.excelName, 'Detalle completo', { chatId });
  }
}

export async function startBotPolling() {
  const { TELEGRAM_BOT_TOKEN } = process.env;
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Falta TELEGRAM_BOT_TOKEN en .env.');
  // Sin TELEGRAM_CHAT_ID el bot no sabría a quién contestar: no arrancar.
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error('Falta TELEGRAM_CHAT_ID en .env (el bot solo responde a ese chat).');

  console.log('Bot escuchando (Ctrl+C para salir)...');
  let offset = 0;

  while (true) {
    try {
      const response = await fetch(`${API_BASE}/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`);
      if (!response.ok) throw new Error(`getUpdates falló: ${response.status}`);
      const data = await response.json();

      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const chatId = update.message?.chat?.id;
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error('Error manejando mensaje:', err);
          if (chatId) {
            await sendTelegramMessage('Uy, algo falló procesando tu consulta. Intenta de nuevo.', { chatId }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('Error en el polling de Telegram:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
