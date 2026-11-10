import http from 'node:http';
import { google } from 'googleapis';
import { getOAuthClient } from './gmail.js';
import { connectUser } from './users.js';
import { sendTelegramMessage } from './telegram.js';
import { backfillUser } from './backfill.js';
import { buildUsageExamplesText } from './messages.js';
import { handleDashboardRequest } from './dashboard.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function getWebOAuthClient() {
  const { GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, PUBLIC_BASE_URL } = process.env;
  if (!GMAIL_WEB_CLIENT_ID || !GMAIL_WEB_CLIENT_SECRET || !PUBLIC_BASE_URL) {
    throw new Error('Faltan GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET o PUBLIC_BASE_URL en .env.');
  }
  const redirectUri = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/oauth/callback`;
  return new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, redirectUri);
}

// URL que el bot manda al usuario para que conecte su Gmail. `state` lleva
// el chat id de Telegram, así el callback sabe a quién asociar el token.
export function buildConnectUrl(chatId) {
  const client = getWebOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: String(chatId),
  });
}

export function startOAuthServer() {
  const port = Number(process.env.PORT) || 3000;
  // Por defecto solo loopback: el dashboard muestra todas las finanzas del
  // dueño y no debe quedar abierto en la interfaz pública de la VPS. HOST=0.0.0.0
  // solo si hay un proxy delante (o para el callback OAuth de otros usuarios).
  const host = process.env.HOST || '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (await handleDashboardRequest(req, res, url)) return;

    // Punto básico de salud para comprobar que el servidor HTTP está activo.
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('email-spend-agent: OK');
      return;
    }

    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const chatId = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error || !code || !chatId) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>No se pudo conectar tu Gmail.</h1><p>Volvé a Telegram e intentá de nuevo con /conectar.</p>');
      return;
    }

    try {
      const client = getWebOAuthClient();
      const { tokens } = await client.getToken(code);

      if (!tokens.refresh_token) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h1>Ya habías conectado esta cuenta antes.</h1>' +
            '<p>Si necesitás reconectar, revocá el acceso en ' +
            '<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> y volvé a intentar.</p>'
        );
        return;
      }

      await connectUser(chatId, tokens.refresh_token);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Listo, tu Gmail quedó conectado.</h1><p>Volvé a Telegram.</p>');

      await sendTelegramMessage(
        `✅ Tu Gmail quedó conectado. Estoy revisando tus últimos ${NEW_USER_BACKFILL_MONTHS} meses de correos ` +
          '(puede tomar varios minutos), te aviso apenas termine.',
        { chatId }
      ).catch((err) => console.error('No se pudo avisar por Telegram:', err.message));

      // Backfill de NEW_USER_BACKFILL_MONTHS en background: no bloquea la
      // respuesta HTTP ni el resto del bot. Es un costo único por usuario
      // (~centavos), el polling normal después es el que se encarga de lo nuevo.
      runInitialBackfill(chatId, tokens.refresh_token);
    } catch (err) {
      console.error('Error en OAuth callback:', err);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Algo falló conectando tu Gmail.</h1>');
    }
  });

  server.listen(port, host, () => {
    console.log(`Servidor escuchando en http://${host}:${port} (dashboard en /dashboard)`);
  });

  return server;
}

// Ventana del backfill inicial para usuarios nuevos (no el dueño). Más
// corta que los 12 meses de la ingesta del dueño para no gastar de más — a
// costa de no poder detectar suscripciones anuales para esos usuarios
// (necesitan 2 ocurrencias ~12 meses aparte, que 6 meses no puede mostrar).
export const NEW_USER_BACKFILL_MONTHS = 6;

async function runInitialBackfill(chatId, refreshToken) {
  try {
    const oauth = getOAuthClient({
      clientId: process.env.GMAIL_WEB_CLIENT_ID,
      clientSecret: process.env.GMAIL_WEB_CLIENT_SECRET,
      refreshToken,
    });

    const { totalCorreos, gastosEncontrados } = await backfillUser({
      oauth,
      userId: String(chatId),
      months: NEW_USER_BACKFILL_MONTHS,
      onProgress: (processed, total, percent) =>
        sendTelegramMessage(`⏳ Sigo revisando tus correos... ${percent}% (${processed} de ${total}).`, { chatId }).catch(
          (err) => console.error('No se pudo avisar progreso del backfill:', err.message)
        ),
    });

    await sendTelegramMessage(
      `📊 Listo. Revisé ${totalCorreos} correos de los últimos ${NEW_USER_BACKFILL_MONTHS} meses y encontré ` +
        `${gastosEncontrados} gastos reales.\n\n${buildUsageExamplesText()}`,
      { chatId }
    );
  } catch (err) {
    console.error(`Error en backfill inicial de ${chatId}:`, err);
    await sendTelegramMessage(
      'Tuve un problema revisando tu Gmail. Probá de nuevo en un rato con /conectar.',
      { chatId }
    ).catch(() => {});
  }
}
