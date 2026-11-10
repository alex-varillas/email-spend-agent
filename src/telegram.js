const API_BASE = 'https://api.telegram.org';

function getToken() {
  const { TELEGRAM_BOT_TOKEN } = process.env;
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Falta TELEGRAM_BOT_TOKEN en .env.');
  return TELEGRAM_BOT_TOKEN;
}

// Sin chatId explícito, usa TELEGRAM_CHAT_ID (el chat del usuario único).
// Con chatId, le contesta a cualquier usuario del bot conversacional.
function resolveChatId(chatId) {
  const target = chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!target) throw new Error('Falta chatId (ni se pasó explícito ni hay TELEGRAM_CHAT_ID en .env).');
  return target;
}

async function assertOk(response, action) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram rechazó ${action}: ${response.status} ${body}`);
  }
}

export async function sendTelegramMessage(text, { chatId } = {}) {
  const token = getToken();
  const targetChatId = resolveChatId(chatId);

  const response = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: targetChatId, text, parse_mode: 'HTML' }),
  });

  await assertOk(response, 'sendMessage');
  return response.json();
}

// `fileBuffer` es un Buffer con el contenido del archivo (ej. el PDF del reporte).
export async function sendTelegramDocument(fileBuffer, filename, caption, { chatId } = {}) {
  const token = getToken();
  const targetChatId = resolveChatId(chatId);

  const form = new FormData();
  form.append('chat_id', targetChatId);
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([fileBuffer]), filename);

  const response = await fetch(`${API_BASE}/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });

  await assertOk(response, 'sendDocument');
  return response.json();
}
