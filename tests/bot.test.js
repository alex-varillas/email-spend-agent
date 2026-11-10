import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, startBotPolling } from '../src/bot.js';

const OWNER_CHAT_ID = 111111;
const STRANGER_CHAT_ID = 999999;

// Ejecuta `fn` con el entorno y `fetch` simulados, y le pasa las llamadas a
// Telegram. Nada sale a la red: sin esto la prueba mandaría mensajes reales.
// `ownerChatId: null` simula que TELEGRAM_CHAT_ID no está definida (no sirve
// `undefined`: el valor por defecto del parámetro lo reemplazaría).
async function withTelegram({ ownerChatId = String(OWNER_CHAT_ID) } = {}, fn) {
  const saved = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    fetch: globalThis.fetch,
  };
  process.env.TELEGRAM_BOT_TOKEN = 'token-de-prueba';
  if (ownerChatId === null) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = ownerChatId;

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => ({ ok: true }), text: async () => '' };
  };
  const log = mock.method(console, 'log', () => {});

  try {
    await fn(calls);
  } finally {
    log.mock.restore();
    globalThis.fetch = saved.fetch;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.chatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = saved.chatId;
  }
}

function messageFrom(chatId, text) {
  return { update_id: 1, message: { chat: { id: chatId }, text } };
}

test('bot privado: un chat que no es el del dueño se ignora, sin respuesta ni onboarding', async () => {
  await withTelegram({}, async (calls) => {
    await handleUpdate(messageFrom(STRANGER_CHAT_ID, '/start'));
    await handleUpdate(messageFrom(STRANGER_CHAT_ID, '/conectar'));
    await handleUpdate(messageFrom(STRANGER_CHAT_ID, 'dame mis gastos'));
    assert.equal(calls.length, 0);
  });
});

test('bot privado: el dueño sí recibe respuesta a /start', async () => {
  await withTelegram({}, async (calls) => {
    await handleUpdate(messageFrom(OWNER_CHAT_ID, '/start'));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sendMessage$/);
    assert.equal(String(calls[0].body.chat_id), String(OWNER_CHAT_ID));
  });
});

test('bot privado: /conectar ya no abre ningún flujo, solo muestra los ejemplos de uso', async () => {
  await withTelegram({}, async (calls) => {
    await handleUpdate(messageFrom(OWNER_CHAT_ID, '/conectar'));
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].body.text, /oauth|conect[aá] tu Gmail/i);
    assert.match(calls[0].body.text, /\/gastos/);
  });
});

test('bot privado: sin TELEGRAM_CHAT_ID no se autoriza a nadie', async () => {
  await withTelegram({ ownerChatId: null }, async (calls) => {
    await handleUpdate(messageFrom(STRANGER_CHAT_ID, '/start'));
    await handleUpdate(messageFrom('undefined', '/start'));
    assert.equal(calls.length, 0);
  });
});

test('bot privado: el bot no arranca si falta TELEGRAM_CHAT_ID', async () => {
  await withTelegram({ ownerChatId: null }, async (calls) => {
    await assert.rejects(startBotPolling(), /TELEGRAM_CHAT_ID/);
    assert.equal(calls.length, 0); // ni siquiera llegó a pedir getUpdates
  });
});
