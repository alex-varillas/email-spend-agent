import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DATA_DIR = new URL('../data/', import.meta.url);
const USERS_FILE = new URL('users.json', DATA_DIR);

export async function loadUsers() {
  try {
    const raw = await readFile(USERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveUsers(users) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// chatId de Telegram como clave (string). Cada usuario conectado tiene su
// propio refresh token de Gmail y, aparte, su propio store en data/users/<chatId>/.
export async function connectUser(chatId, refreshToken) {
  const users = await loadUsers();
  users[String(chatId)] = { refreshToken, connectedAt: new Date().toISOString() };
  await saveUsers(users);
}

export async function getUser(chatId) {
  const users = await loadUsers();
  return users[String(chatId)] ?? null;
}

export async function listUserIds() {
  const users = await loadUsers();
  return Object.keys(users);
}
