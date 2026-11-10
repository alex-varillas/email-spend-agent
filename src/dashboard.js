import { readFile } from 'node:fs/promises';
import { loadStore } from './store.js';
import { dedupeGastos } from './aggregate.js';
import { detectRecurringGroups, filterActiveGroups } from './recurrence.js';

// Dashboard personal del dueño: sirve una página estática y un endpoint JSON
// con el store global (data/gastos.json). Es de lectura únicamente y pensado
// para quedar detrás de un túnel SSH / Tailscale, no expuesto a internet.

const ASSET_DIR = new URL('./dashboard/', import.meta.url);

// Lista cerrada de archivos servibles: ninguna ruta del request llega al
// sistema de archivos; solo se leen las rutas constantes de esta lista.
const ASSETS = new Map([
  ['/dashboard', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/dashboard/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/dashboard/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ['/dashboard/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/analytics.js', { file: 'analytics.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/motion.js', { file: 'motion.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/gsap.min.js', { file: '../../node_modules/gsap/dist/gsap.min.js', type: 'text/javascript; charset=utf-8' }],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Solo responde a Host conocidos: evita que una página externa lea el JSON de
// finanzas vía DNS rebinding contra el puerto local. Para entrar por otro
// nombre (ej. Tailscale) se lista en DASHBOARD_ALLOWED_HOSTS, separado por comas.
function isAllowedHost(hostHeader) {
  const extra = (process.env.DASHBOARD_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const hostname = (hostHeader ?? '').toLowerCase().replace(/:\d+$/, '');
  return [...LOOPBACK_HOSTS, ...extra].includes(hostname);
}

// Solo los campos que el dashboard dibuja; hora es la recepción del correo.
function pickFields(record) {
  const { fecha, hora, vendor, monto, moneda, canal, categoria, banco } = record;
  return { fecha, hora, vendor, monto, moneda, canal, categoria, banco };
}

// Mismo tratamiento que el bot (dedupe de recibo + aviso de tarjeta, y solo
// suscripciones aún vigentes), para que los totales coincidan con Telegram.
export function buildDashboardData(records, { today = new Date() } = {}) {
  const deduped = dedupeGastos(
    records.filter((record) => record.es_cobro && record.fecha),
    { log: () => {} }
  );
  const suscripciones = filterActiveGroups(detectRecurringGroups(deduped), { today });
  const fechas = deduped.map((record) => record.fecha).sort();

  return {
    generadoEn: today.toISOString(),
    ultimaFecha: fechas.at(-1) ?? null,
    gastos: deduped.map(pickFields),
    suscripciones,
  };
}

function send(req, res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Devuelve true si atendió el request (la ruta era del dashboard).
export async function handleDashboardRequest(req, res, url) {
  if (!url.pathname.startsWith('/dashboard')) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    return true;
  }

  if (!isAllowedHost(req.headers.host)) {
    send(req, res, 403, 'text/plain; charset=utf-8', 'Host no permitido');
    return true;
  }

  try {
    if (url.pathname === '/dashboard/api/data') {
      const data = buildDashboardData(await loadStore());
      send(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(data));
      return true;
    }

    const asset = ASSETS.get(url.pathname);
    if (!asset) {
      send(req, res, 404, 'text/plain; charset=utf-8', 'Not found');
      return true;
    }

    send(req, res, 200, asset.type, await readFile(new URL(asset.file, ASSET_DIR)));
  } catch (err) {
    console.error('Error en el dashboard:', err);
    send(req, res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'No se pudo leer los gastos.' }));
  }
  return true;
}
