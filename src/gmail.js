import { google } from 'googleapis';

// Palabras clave de cobro. La búsqueda solo acota candidatos (el filtro real
// lo hace extract.js): ajustar según lo que llegue a tu bandeja.
const KEYWORDS = [
  'recibo',
  'receipt',
  'invoice',
  'subscription',
  'suscripción',
  'renovación',
  'factura',
  '"constancia de operación"',
  '"confirmación de pago"',
  // Retiros de efectivo: cuentan como gasto, y no todos los bancos que los
  // avisan están en KNOWN_SENDERS.
  '"constancia de retiro"',
  '"retiro de efectivo"',
  // Cobro fallido/rechazado — misma lógica: la búsqueda solo acota
  // candidatos, el filtro real lo hace extract.js.
  '"no se pudo procesar"',
  '"pago rechazado"',
  '"cargo rechazado"',
  '"fondos insuficientes"',
  '"tarjeta rechazada"',
  '"payment failed"',
  '"payment declined"',
  '"insufficient funds"',
];

// Remitentes conocidos (bancos/procesadores/billeteras locales). Son
// coincidencias parciales sobre el remitente, no dominios exactos
// confirmados: ajustar según los bancos y billeteras que uses. La lista cubre
// bancos, billeteras digitales y procesadores de tarjeta de Perú y Argentina.
// Perú:
const KNOWN_SENDERS = [
  'bbva',
  'bcp',
  'izipay',
  'culqi',
  // Argentina — bancos
  'galicia',
  'santander',
  'bancoprovincia',
  'bancociudad',
  'bancomacro',
  'bancosupervielle',
  'bancocomafi',
  'hsbc',
  'icbc',
  'brubank',
  // Argentina — billeteras digitales
  'mercadopago',
  'uala',
  'naranjax',
  'tarjetanaranja',
  'personalpay',
  'cuentadni',
  'modo.com.ar', // dominio completo: "modo" solo es una palabra demasiado genérica
  // Argentina — procesadores de tarjeta
  'prismamediosdepago',
  'payway',
  'todopago',
  'decidir.com', // dominio completo, mismo motivo que "modo"
  'cabal',
];

// `days`, si se pasa, manda sobre `months` — para ventanas cortas (polling
// de novedades) donde un mes de precisión no alcanza.
export function buildSearchQuery({ months = 12, days } = {}) {
  const after = new Date();
  if (days != null) {
    after.setDate(after.getDate() - days);
  } else {
    after.setMonth(after.getMonth() - months);
  }
  const afterStr = `${after.getFullYear()}/${String(after.getMonth() + 1).padStart(2, '0')}/${String(
    after.getDate()
  ).padStart(2, '0')}`;

  const keywordTerms = KEYWORDS.join(' OR ');
  const senderTerms = KNOWN_SENDERS.map((sender) => `from:${sender}`).join(' OR ');

  return `after:${afterStr} (${keywordTerms} OR ${senderTerms})`;
}

// Sin argumentos, usa las credenciales del usuario único (.env) — como hasta
// ahora. Con overrides, sirve para el flujo multiusuario (cada usuario tiene
// su propio refresh token, obtenido vía el flujo web en oauthServer.js).
export function getOAuthClient({ clientId, clientSecret, refreshToken } = {}) {
  const id = clientId ?? process.env.GMAIL_CLIENT_ID;
  const secret = clientSecret ?? process.env.GMAIL_CLIENT_SECRET;
  const token = refreshToken ?? process.env.GMAIL_REFRESH_TOKEN;

  if (!id || !secret || !token) {
    throw new Error(
      'Faltan credenciales de Gmail (client id/secret/refresh token). ' +
        'Corre `npm run authorize-gmail` para el usuario único, o conectá una cuenta vía el bot.'
    );
  }

  const client = new google.auth.OAuth2(id, secret);
  client.setCredentials({ refresh_token: token });
  return client;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBody(payload) {
  if (!payload) return '';

  if (payload.body?.data && (payload.mimeType === 'text/plain' || payload.mimeType === 'text/html')) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    return payload.mimeType === 'text/html' ? stripHtml(decoded) : decoded;
  }

  if (payload.parts) {
    const plainPart = payload.parts.find((part) => part.mimeType === 'text/plain');
    if (plainPart) return extractBody(plainPart);

    const htmlPart = payload.parts.find((part) => part.mimeType === 'text/html');
    if (htmlPart) return extractBody(htmlPart);

    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

function getHeader(headers, name) {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Trae los correos candidatos de los últimos `months` meses. Cada uno se
// entrega crudo (sin clasificar); el paso de extracción por IA (extract.js)
// decide cuáles son cobros reales.
export async function searchCandidateEmails({ months = 12, days, maxResults = 500, auth } = {}) {
  const client = auth ?? getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth: client });
  const query = buildSearchQuery({ months, days });

  const ids = [];
  let pageToken;

  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken,
    });

    if (data.messages) ids.push(...data.messages.map((message) => message.id));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < maxResults);

  // Fetch en lotes chicos en paralelo (la cuota de Gmail por usuario aguanta
  // esto sin problema, y es mucho más rápido que uno por uno con miles de
  // correos).
  const targetIds = ids.slice(0, maxResults);
  const emails = [];
  const fetchBatchSize = 10;

  for (let i = 0; i < targetIds.length; i += fetchBatchSize) {
    const batch = targetIds.slice(i, i + fetchBatchSize);
    const batchEmails = await Promise.all(
      batch.map(async (id) => {
        const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const headers = data.payload?.headers ?? [];

        return {
          id: data.id,
          threadId: data.threadId,
          from: getHeader(headers, 'From'),
          subject: getHeader(headers, 'Subject'),
          date: getHeader(headers, 'Date'),
          // Timestamp real de recepción del correo (ms epoch, según Gmail),
          // más confiable que pedirle al LLM que infiera una hora del texto.
          receivedAt: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null,
          snippet: data.snippet ?? '',
          bodyText: extractBody(data.payload).slice(0, 3000),
        };
      })
    );
    emails.push(...batchEmails);
  }

  return emails;
}
