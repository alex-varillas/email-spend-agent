import OpenAI from 'openai';
import { CASH_WITHDRAWAL_CATEGORY } from './aggregate.js';

const CATEGORIES = [
  'Suscripciones/Software',
  'Entretenimiento',
  'Comida',
  'Transporte',
  'Servicios',
  'Salud',
  'Educación',
  'Compras',
  'Transferencias personales',
  CASH_WITHDRAWAL_CATEGORY,
  'Otros',
];

// Banco/procesador detectado por el remitente del correo, no por el LLM
// (determinístico y gratis — no suma tokens ni llamadas).
const BANK_PATTERNS = [
  // Perú
  { pattern: /bbva/i, name: 'BBVA' },
  { pattern: /bcp|viabcp/i, name: 'BCP' },
  { pattern: /interbank/i, name: 'Interbank' },
  { pattern: /scotiabank/i, name: 'Scotiabank' },
  { pattern: /izipay/i, name: 'izipay' },
  { pattern: /culqi/i, name: 'Culqi' },
  { pattern: /bancodelanacion|banconacion/i, name: 'Banco de la Nación' },
  { pattern: /niubiz|visanet/i, name: 'Niubiz' },
  // Argentina
  { pattern: /galicia/i, name: 'Banco Galicia' },
  { pattern: /santander/i, name: 'Santander' },
  { pattern: /bancoprovincia|\bbapro\b/i, name: 'Banco Provincia' },
  { pattern: /bancociudad/i, name: 'Banco Ciudad' },
  { pattern: /bancomacro/i, name: 'Banco Macro' },
  { pattern: /supervielle/i, name: 'Banco Supervielle' },
  { pattern: /bancocomafi/i, name: 'Banco Comafi' },
  { pattern: /hsbc/i, name: 'HSBC' },
  { pattern: /icbc/i, name: 'ICBC' },
  { pattern: /brubank/i, name: 'Brubank' },
  { pattern: /mercado ?pago/i, name: 'Mercado Pago' },
  { pattern: /ualá|uala/i, name: 'Ualá' },
  { pattern: /naranjax|tarjetanaranja|naranja x/i, name: 'Naranja X' },
  { pattern: /personalpay/i, name: 'Personal Pay' },
  { pattern: /cuentadni/i, name: 'Cuenta DNI' },
  { pattern: /modo\.com\.ar/i, name: 'MODO' },
  { pattern: /prismamediosdepago|prisma medios/i, name: 'Prisma Medios de Pago' },
  { pattern: /payway/i, name: 'Payway' },
  { pattern: /todopago/i, name: 'Todo Pago' },
  { pattern: /decidir\.com/i, name: 'Decidir' },
  { pattern: /cabal/i, name: 'Cabal' },
];

function detectBanco(from) {
  if (!from) return null;
  const match = BANK_PATTERNS.find(({ pattern }) => pattern.test(from));
  return match?.name ?? null;
}

const SYSTEM_PROMPT = `Eres un extractor de datos financieros. Te paso el contenido de un correo de Gmail y extraes los datos según el schema dado.

Reglas:
- "es_cobro" es true solo si el correo confirma un movimiento de dinero real: un recibo, una confirmación de pago, una renovación de suscripción, una constancia de transferencia (Yape, Plin, banco), o un cargo a tarjeta. No importa si es recurrente o no, si hay dinero moviéndose de verdad, es true.
- "es_cobro" es false para: newsletters, avisos de producto o de features nuevas, avisos de que un proyecto/servicio se pausó por estar en plan gratuito (no hay cobro), comunicados operativos de procesadores de pago dirigidos a una cuenta de negocio del usuario (no es un gasto personal), o cualquier correo que no confirme un movimiento de dinero.
- Los boletines promocionales o de ofertas (aerolíneas, tiendas, cursos, etc.) casi siempre mencionan precios (ej. "vuelos desde S/173", "hasta 40% dcto", "compra tiquetes desde USD 199"), pero mostrar un precio NO es lo mismo que confirmar un cobro. La pregunta clave: ¿el correo confirma algo que YA pasó (una compra ya hecha, con número de operación/reserva/orden y el monto específico que se te cobró), o es una invitación a comprar algo a futuro ("compra ahora", "aprovecha", "elige tu destino", "desde $X")? Si es lo segundo, "es_cobro" es false aunque el correo contenga números que parezcan montos.
- Un retiro de efectivo en cajero o agente ("constancia de retiro", "retiro de efectivo") SÍ es un gasto: para este usuario cuenta como gasto todo el dinero que sale de sus cuentas de banco, aunque no lo reciba un tercero. "es_cobro" es true, "vendor" es "Retiro de efectivo", "categoria" es "${CASH_WITHDRAWAL_CATEGORY}" y "canal" es "cajero". Si el correo no confirma un retiro ya hecho con su monto (ej. un aviso de cajeros cercanos o una promoción), "es_cobro" es false.
- "vendor" es el nombre del comercio, servicio o persona que recibió el pago. Si es una transferencia a una persona (Yape/Plin), usa el nombre de la persona tal como aparece en el correo.
- "monto" es el número del cobro, sin símbolo de moneda (usa punto decimal).
- "moneda" es el código de moneda: PEN, USD, ARS, etc. Si el correo usa "S/", es PEN. El símbolo "$" es ambiguo entre USD y ARS — si el banco, billetera o comercio es claramente argentino (ej. Banco Galicia, Santander, Banco Macro, Mercado Pago, Ualá, Naranja X, MODO, Cabal) o el correo menciona "ARS" o "pesos argentinos", es ARS; si el contexto es claramente de EE.UU. o no hay ninguna señal de Argentina, es USD.
- "fecha" es la fecha del cobro en formato YYYY-MM-DD, tomada del contenido del correo si está disponible, si no, de la fecha del correo.
- "canal" es uno de los valores del enum, o "otro" si no aplica ninguno.
- "categoria" es la que mejor describe el gasto: software/IA/streaming recurrente va en "Suscripciones/Software" (incluso streaming como Spotify), transferencias Yape/Plin/Mercado Pago/MODO a una persona van en "Transferencias personales" salvo que el contexto deje claro que es otra cosa (ej. pagar comida a través de Yape a un restaurante), servicios como luz/agua/internet/gas van en "Servicios".
- Si no hay un monto real mayor a 0 involucrado (ej: solo un aviso de que el acceso o la suscripción fue restaurada/reactivada, sin indicar el monto cobrado), "es_cobro" es false.
- "intento_fallido" es true cuando el correo confirma que un intento de cobro o pago NO se pudo completar (pago rechazado, fondos insuficientes, tarjeta vencida o rechazada, cobro no procesado). En ese caso "es_cobro" sigue siendo false (no se movió dinero), pero sí completa "vendor" y, si el correo lo menciona, "monto", "moneda" y "fecha" — no van en null aunque "es_cobro" sea false. Para cualquier otro correo (incluyendo cobros exitosos), "intento_fallido" es false.
- Si "es_cobro" es false y "intento_fallido" es también false, los demás campos van en null.`;

const EXTRACTION_SCHEMA = {
  name: 'email_extraction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      es_cobro: {
        type: 'boolean',
        description: 'true si el correo confirma un movimiento de dinero real, false si es ruido (newsletter, aviso de producto, etc).',
      },
      intento_fallido: {
        type: 'boolean',
        description: 'true si el correo confirma que un intento de cobro/pago no se pudo completar (rechazado, fondos insuficientes, etc). es_cobro sigue siendo false en ese caso.',
      },
      vendor: { type: ['string', 'null'], description: 'Comercio, servicio o persona que recibió el pago.' },
      monto: { type: ['number', 'null'], description: 'Monto del cobro, sin símbolo de moneda.' },
      moneda: { type: ['string', 'null'], description: 'Código de moneda: PEN, USD, ARS, etc.' },
      fecha: { type: ['string', 'null'], description: 'Fecha del cobro en formato YYYY-MM-DD.' },
      canal: {
        type: ['string', 'null'],
        enum: ['Yape', 'Plin', 'Mercado Pago', 'MODO', 'tarjeta', 'transferencia', 'Google Play', 'App Store', 'directo', 'cajero', 'otro', null],
      },
      categoria: {
        type: ['string', 'null'],
        description: 'Categoría del gasto.',
        enum: [...CATEGORIES, null],
      },
    },
    required: ['es_cobro', 'intento_fallido', 'vendor', 'monto', 'moneda', 'fecha', 'canal', 'categoria'],
    additionalProperties: false,
  },
};

function buildUserPrompt(email) {
  return [
    `De: ${email.from}`,
    `Asunto: ${email.subject}`,
    `Fecha del correo: ${email.date}`,
    '',
    'Contenido:',
    email.bodyText || email.snippet || '(sin contenido)',
  ].join('\n');
}

let client;
function getClient() {
  if (!client) {
    const { OPENAI_API_KEY } = process.env;
    if (!OPENAI_API_KEY) {
      throw new Error('Falta OPENAI_API_KEY en .env.');
    }
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return client;
}

async function withRateLimitRetry(fn, { retries = 6, baseDelayMs = 2000, maxWaitMs = 20000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err?.status === 429;
      if (!isRateLimit || attempt >= retries) throw err;

      const retryAfterHeader = err?.headers?.get?.('retry-after');
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : baseDelayMs * 2 ** attempt;

      if (waitMs > maxWaitMs) {
        throw new Error(
          `OpenAI pide esperar ~${Math.round(waitMs / 60000)} min por límite de cuota. Deteniendo en vez de esperar tanto.`
        );
      }

      console.warn(`  Rate limit de OpenAI, reintentando en ${Math.round(waitMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export async function extractFromEmail(email) {
  const openai = getClient();
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const completion = await withRateLimitRetry(() =>
    openai.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: EXTRACTION_SCHEMA },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(email) },
      ],
    })
  );

  const raw = completion.choices[0]?.message?.content ?? '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI devolvió un JSON inválido para el correo ${email.id}: ${raw}`);
  }

  return {
    emailId: email.id,
    es_cobro: Boolean(parsed.es_cobro),
    intento_fallido: Boolean(parsed.intento_fallido),
    vendor: parsed.vendor ?? null,
    monto: parsed.monto ?? null,
    moneda: parsed.moneda ?? null,
    fecha: parsed.fecha ?? null,
    canal: parsed.canal ?? null,
    categoria: parsed.categoria ?? null,
    // Hora real de recepción del correo (Gmail), no inferida por el LLM.
    hora: email.receivedAt ?? null,
    // Banco/procesador detectado por el remitente, no por el LLM.
    banco: detectBanco(email.from),
  };
}

// Procesa varios correos en lotes pequeños, con una pausa entre lotes.
export async function extractFromEmails(emails, { batchSize = 5, delayMs = 500 } = {}) {
  const results = [];
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((email) => extractFromEmail(email)));
    results.push(...batchResults);

    if (i + batchSize < emails.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return results;
}
