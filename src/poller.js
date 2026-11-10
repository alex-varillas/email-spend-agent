// Revisa periódicamente Gmail de cada cuenta conectada (el dueño + usuarios
// del bot multiusuario) buscando gastos nuevos, y avisa por Telegram al
// momento — tanto gastos sueltos como "esto se volvió una suscripción".

import { searchCandidateEmails, getOAuthClient } from './gmail.js';
import { extractFromEmail } from './extract.js';
import { loadStore, upsertGastos } from './store.js';
import { dedupeGastos, normalizeVendor } from './aggregate.js';
import { detectRecurringGroups } from './recurrence.js';
import { sendTelegramMessage } from './telegram.js';
import { loadUsers } from './users.js';
import { loadAlertState, saveAlertState, checkReminders, checkMissedCharges } from './subscriptionAlerts.js';
import { loadSeenEmailIds, addSeenEmailIds } from './seenEmails.js';

const POLL_WINDOW_DAYS = 3; // ventana chica con margen, no toda la ventana de 12 meses

function formatMoney(amount, currency) {
  return `${Number(amount).toFixed(2)} ${currency}`;
}

function recurringKeySet(groups) {
  return new Set(groups.map((group) => `${normalizeVendor(group.vendor)}::${group.moneda}`));
}

function buildFailedChargeMessage(result) {
  const detalle = result.monto ? ` (${formatMoney(result.monto, result.moneda ?? '')})` : '';
  return `⚠️ <b>Intento de cobro fallido</b>\n${result.vendor ?? 'Vendor desconocido'} — el correo indica que un cobro no se pudo procesar${detalle}.`;
}

function buildReminderMessage(group) {
  const dias = group.diasRestantes === 1 ? '1 día' : `${group.diasRestantes} días`;
  return `⏰ <b>Recordatorio de cobro</b>\n${group.vendor} — ${formatMoney(group.montoActual, group.moneda)} se cobra en ${dias} (el ${group.proximoEstimado})`;
}

function buildMissedChargeMessage(group) {
  return `❓ <b>Posible cancelación</b>\n${group.vendor} no registró el cobro esperado del ${group.proximoEstimado} (${formatMoney(group.montoActual, group.moneda)}). Si no cancelaste, revisá tu medio de pago.`;
}

async function pollOneAccount({ userId, chatId, oauth }) {
  const before = await loadStore(userId);
  const seenIds = await loadSeenEmailIds(userId);
  // beforeIds junta lo persistido (gastos e intentos fallidos) con el
  // ruido ya revisado — sin el segundo, el poller le vuelve a mandar el
  // mismo correo irrelevante a OpenAI en cada ciclo mientras siga dentro
  // de la ventana de POLL_WINDOW_DAYS.
  const beforeIds = new Set([...before.map((record) => record.emailId), ...seenIds]);
  const beforeRecurring = recurringKeySet(detectRecurringGroups(dedupeGastos(before.filter((r) => r.es_cobro))));

  const emails = await searchCandidateEmails({ days: POLL_WINDOW_DAYS, maxResults: 100, auth: oauth });
  const newEmails = emails.filter((email) => !beforeIds.has(email.id));

  let currentGastos = before;

  // El resto de la función (recordatorios, cobro no efectuado) depende de la
  // fecha de hoy, no de correos nuevos, así que corre siempre. Solo este
  // bloque se salta cuando no hay novedades en Gmail.
  if (newEmails.length > 0) {
    const newResults = [];
    for (const email of newEmails) {
      const result = await extractFromEmail(email);
      newResults.push(result);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const newGastos = newResults.filter((result) => result.es_cobro);
    const newFailedAttempts = newResults.filter((result) => result.intento_fallido);

    // Los intentos fallidos también se guardan (aunque es_cobro sea false):
    // si no quedan en el store, su emailId nunca entra a beforeIds, y el
    // poller los vuelve a encontrar como "nuevos" en cada ciclo mientras
    // sigan dentro de la ventana de POLL_WINDOW_DAYS — se reavisaba el mismo
    // intento fallido una y otra vez. filterGastos y el resto de los
    // consumidores del store ya filtran por es_cobro, así que guardar estos
    // registros de más no afecta ningún cálculo de gastos/recurrencia.
    currentGastos = await upsertGastos([...newGastos, ...newFailedAttempts], userId);
    // Todo lo procesado este ciclo queda marcado como visto, incluido el
    // ruido puro (ni gasto ni intento fallido) — así no se le vuelve a
    // pagar a OpenAI por clasificar el mismo newsletter/boletín de nuevo.
    await addSeenEmailIds(newEmails.map((email) => email.id), userId);

    for (const gasto of newGastos) {
      await sendTelegramMessage(
        `💸 <b>Nuevo gasto detectado</b>\n${gasto.vendor} — ${formatMoney(gasto.monto, gasto.moneda)}\n` +
          `${gasto.categoria ?? 'Sin categoría'} · ${gasto.canal} · ${gasto.fecha}`,
        { chatId }
      ).catch((err) => console.error('No se pudo avisar gasto nuevo:', err.message));
    }

    for (const result of newFailedAttempts) {
      await sendTelegramMessage(buildFailedChargeMessage(result), { chatId }).catch((err) =>
        console.error('No se pudo avisar intento de cobro fallido:', err.message)
      );
    }
  }

  const currentRecurring = detectRecurringGroups(dedupeGastos(currentGastos.filter((r) => r.es_cobro)));

  for (const group of currentRecurring) {
    const key = `${normalizeVendor(group.vendor)}::${group.moneda}`;
    if (beforeRecurring.has(key)) continue;

    await sendTelegramMessage(
      `🔁 <b>Nueva suscripción detectada</b>\n${group.vendor} — ${formatMoney(group.montoActual, group.moneda)} ` +
        `(${group.frecuencia})\nPróximo cobro estimado: ${group.proximoEstimado}`,
      { chatId }
    ).catch((err) => console.error('No se pudo avisar suscripción nueva:', err.message));
  }

  let alertState = await loadAlertState(userId);
  let alertStateChanged = false;

  const reminders = checkReminders(currentRecurring, alertState);
  alertState = reminders.state;
  alertStateChanged ||= reminders.due.length > 0;
  for (const group of reminders.due) {
    await sendTelegramMessage(buildReminderMessage(group), { chatId }).catch((err) =>
      console.error('No se pudo avisar recordatorio de cobro:', err.message)
    );
  }

  const missed = checkMissedCharges(currentRecurring, alertState);
  alertState = missed.state;
  alertStateChanged ||= missed.due.length > 0;
  for (const group of missed.due) {
    await sendTelegramMessage(buildMissedChargeMessage(group), { chatId }).catch((err) =>
      console.error('No se pudo avisar cobro no efectuado:', err.message)
    );
  }

  if (alertStateChanged) await saveAlertState(alertState, userId);
}

async function pollAll() {
  console.log(`[poll] revisando cuentas — ${new Date().toISOString()}`);

  const ownerChatId = process.env.TELEGRAM_CHAT_ID;
  if (ownerChatId) {
    try {
      await pollOneAccount({ userId: undefined, chatId: ownerChatId, oauth: getOAuthClient() });
    } catch (err) {
      console.error('[poll] error revisando la cuenta del dueño:', err.message);
    }
  }

  const users = await loadUsers();
  for (const [chatId, user] of Object.entries(users)) {
    try {
      const oauth = getOAuthClient({
        clientId: process.env.GMAIL_WEB_CLIENT_ID,
        clientSecret: process.env.GMAIL_WEB_CLIENT_SECRET,
        refreshToken: user.refreshToken,
      });
      await pollOneAccount({ userId: chatId, chatId, oauth });
    } catch (err) {
      console.error(`[poll] error revisando la cuenta ${chatId}:`, err.message);
    }
  }

  console.log('[poll] listo.');
}

export async function startPolling() {
  const intervalMs = Number(process.env.POLL_INTERVAL_MINUTES ?? 10) * 60_000;

  while (true) {
    await pollAll().catch((err) => console.error('[poll] error general:', err));
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
