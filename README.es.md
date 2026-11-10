# email-spend-agent

Agente personal que lee tu Gmail, detecta con un LLM cada gasto y cada suscripción
recurrente, te avisa por Telegram y los muestra en un dashboard privado.

> English summary: [README.md](README.md)

## Qué hace

- **Encuentra gastos en tu bandeja.** Recibos, avisos de tarjeta, constancias de
  transferencia, pagos con billeteras (Yape, Plin, Mercado Pago, MODO...) y retiros
  de efectivo. El acceso a Gmail es de solo lectura.
- **Extrae datos estructurados con OpenAI.** Comercio, monto, moneda, fecha, canal y
  categoría, con Structured Outputs.
- **Cuenta como gasto todo el dinero que sale de tus cuentas de banco**, fusiona el
  mismo cobro cuando llega por dos correos (recibo del comercio y aviso de tarjeta) y
  detecta suscripciones mensuales y anuales.
- **Te avisa por Telegram.** Gasto nuevo, suscripción nueva, recordatorio de cobro
  próximo, posible cancelación e intento de cobro fallido. También puedes preguntarle
  en lenguaje natural ("cuánto gasté en agosto") y recibes un resumen y un Excel.
- **Dashboard privado.** Gráficas, filtros, suscripciones activas y tabla de
  movimientos con detalle, servido solo en `127.0.0.1`.

## Alcance y estado

- **Una sola persona, en tu propio equipo.** No es un servicio alojado ni multiusuario.
- **Pensado para Perú y Argentina.** Las listas de bancos y billeteras, el manejo de
  PEN, USD y ARS, los prompts del LLM y los mensajes del bot están en español. Para
  adaptarlo a otro país, edita `BANK_PATTERNS` y el prompt en `src/extract.js`, y las
  palabras clave y remitentes conocidos en `src/gmail.js`.
- **Versión 0.1.0.** Funciona bien en una máquina de desarrollo. La guía de
  [docs/despliegue.md](docs/despliegue.md) todavía no se ha validado de punta a punta
  en un servidor real; las correcciones son bienvenidas.

## Qué cuenta como gasto

Cualquier movimiento que confirme dinero saliendo de tus cuentas: cargos de tarjeta,
transferencias, pagos con billetera, recibos de servicios y suscripciones, y retiros
de efectivo en cajero. No cuentan los boletines con precios, los avisos de producto ni
las ofertas, porque no confirman un cobro hecho. Un intento de cobro rechazado se
registra aparte y genera un aviso, pero no suma al total.

Categorías: Suscripciones/Software, Entretenimiento, Comida, Transporte, Servicios,
Salud, Educación, Compras, Transferencias personales, Retiros de efectivo y Otros.

## Requisitos

- Node.js 20 o superior.
- Una cuenta de Google y un proyecto de Google Cloud con la Gmail API habilitada.
- Una API key de OpenAI (de pago, según uso).
- Un token de bot de Telegram, que se crea con [@BotFather](https://t.me/BotFather).
- Una API key de [Groq](https://console.groq.com). Es opcional: solo se usa para
  entender preguntas en texto libre. Sin ella, los comandos `/gastos` y
  `/suscripciones` siguen funcionando.

## Instalación paso a paso

```bash
git clone https://github.com/alex-varillas/email-spend-agent.git
cd email-spend-agent
npm ci
cp .env.example .env        # en Windows PowerShell: Copy-Item .env.example .env
```

### 1. Gmail

1. En [Google Cloud Console](https://console.cloud.google.com) crea un proyecto y
   habilita la **Gmail API**.
2. Configura la pantalla de consentimiento OAuth y añade tu correo como usuario de
   prueba.
3. Crea credenciales OAuth de tipo **Desktop app**. Copia el id y el secreto a
   `GMAIL_CLIENT_ID` y `GMAIL_CLIENT_SECRET` en `.env`.
4. Ejecuta `npm run authorize-gmail`, abre la URL que imprime, acepta el consentimiento
   y pega el refresh token que muestra en `GMAIL_REFRESH_TOKEN`. El script usa el
   puerto 3000, así que no debe haber otro proceso en él.

**Importante:** mientras la pantalla de consentimiento esté en estado *Testing*,
Google caduca los refresh tokens a los 7 días y el agente dejaría de leer tu correo.
Para uso prolongado cambia el estado de publicación a *In production*. Verás el aviso
de "aplicación no verificada" con tu propia cuenta, y puedes continuar.

### 2. OpenAI

Pon tu clave en `OPENAI_API_KEY`. El modelo es `OPENAI_MODEL` (por defecto
`gpt-4o-mini`).

### 3. Telegram

1. Habla con @BotFather, usa `/newbot` y copia el token a `TELEGRAM_BOT_TOKEN`.
2. Escríbele cualquier mensaje a tu bot nuevo.
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador y copia el
   valor de `message.chat.id` a `TELEGRAM_CHAT_ID`. No hagas esto mientras el bot esté
   corriendo.

El bot responde **solo a ese chat** y no arranca si falta la variable. Cualquier otro
chat se ignora en silencio.

### 4. Groq (opcional)

Pon tu clave en `GROQ_API_KEY`. El modelo es `GROQ_CHAT_MODEL` (por defecto
`openai/gpt-oss-20b`).

### 5. Cargar tu historial

```bash
npm run ingest -- 3        # últimos 3 meses
```

Llama a OpenAI, así que conviene empezar con una ventana corta. Cada extracción se
guarda en `.cache/extractions.json` por id de correo: si el proceso se corta o lo
repites, no se paga dos veces por el mismo correo. Los gastos quedan en
`data/gastos.json`.

### 6. Arrancar

```bash
npm start
```

Lanza en un solo proceso el bot de Telegram, el poller y el dashboard. Abre
<http://localhost:3000/dashboard>.

Telegram solo admite **un** consumidor de `getUpdates` por bot. No ejecutes `npm start`
en dos equipos con el mismo token.

## Usar el bot

| Escribe | Resultado |
|---|---|
| `/gastos` | Resumen del mes en curso (total, por categoría, parte recurrente) y Excel con el detalle |
| `/suscripciones` | Lista de cobros recurrentes activos con su próximo cobro estimado |
| "dame los gastos de los últimos 15 días" | Lo mismo que `/gastos`, con el rango que pidas |
| "cuánto gasté en agosto" | Interpretado con Groq como gastos de ese mes |
| "muéstrame mis suscripciones" | Lo mismo que `/suscripciones` |

El poller revisa tu correo cada `POLL_INTERVAL_MINUTES` y te escribe cuando detecta
algo nuevo.

## Variables de entorno

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | Cliente OAuth tipo Desktop app | |
| `GMAIL_REFRESH_TOKEN` | Lo imprime `npm run authorize-gmail` | |
| `OPENAI_API_KEY` | Extracción de datos de los correos | |
| `OPENAI_MODEL` | Modelo de extracción | `gpt-4o-mini` |
| `TELEGRAM_BOT_TOKEN` | Token del bot | |
| `TELEGRAM_CHAT_ID` | Único chat al que responde el bot (obligatoria) | |
| `GROQ_API_KEY` | Texto libre del bot (opcional) | |
| `GROQ_CHAT_MODEL` | Modelo de Groq | `openai/gpt-oss-20b` |
| `HOST` | Interfaz del servidor HTTP del dashboard | `127.0.0.1` |
| `PORT` | Puerto del servidor HTTP | `3000` |
| `DASHBOARD_ALLOWED_HOSTS` | Nombres de `Host` extra permitidos, separados por comas | vacío |
| `POLL_INTERVAL_MINUTES` | Cada cuánto revisa correos nuevos | `10` |
| `SEARCH_MONTHS` | Ventana de `npm run preview` | `12` |
| `GMAIL_WEB_CLIENT_ID`, `GMAIL_WEB_CLIENT_SECRET`, `PUBLIC_BASE_URL` | Flujo multiusuario heredado. Dejar vacías | |

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Bot, poller y dashboard en un solo proceso (entrada de producción) |
| `npm run dashboard` | Solo el dashboard, en `http://127.0.0.1:3000/dashboard` |
| `npm run ingest -- [meses] [máx]` | Busca, extrae y guarda gastos (con caché, reanudable) |
| `npm run poll` | Solo el poller |
| `npm run preview -- [n]` | Prueba en seco: extrae e imprime una muestra sin guardar |
| `npm run authorize-gmail` | OAuth de Gmail, una sola vez |
| `npm run backfill-banco` | Migración puntual: añade el campo `banco` a gastos antiguos |
| `npm test` | Suite completa (sin red ni claves) |

## Privacidad y costo

- **El texto de tus correos sale a terceros.** Los correos candidatos se envían a
  OpenAI para extraerlos, y tus preguntas al bot se envían a Groq. Lee sus políticas de
  datos antes de usarlo con un buzón que te importe.
- **Lo demás se queda en tu equipo:** los gastos en `data/`, la caché en `.cache/` y
  las claves en `.env`. Ninguno de los tres se versiona.
- **OpenAI cobra por uso.** Ingerir un año de correo es un costo único y el poller solo
  clasifica correos nuevos. Empieza con `npm run ingest -- 1`.

## Seguridad

El dashboard **no tiene login** y escucha solo en `127.0.0.1`. Entra por un túnel SSH o
por una red privada como Tailscale. No lo expongas en `0.0.0.0` ni con un dominio sin
autenticación delante. Más detalle en [SECURITY.md](SECURITY.md).

## Despliegue

Sirve cualquier equipo con Node.js 20+ y disco persistente: una VPS pequeña, un
servidor casero o una Raspberry Pi. El almacenamiento es un archivo JSON local y el
bot es un proceso de larga duración, así que las plataformas serverless no encajan.
[docs/despliegue.md](docs/despliegue.md) explica una VPS con systemd, el túnel SSH para
el dashboard y las copias de seguridad. Todavía no hay imagen de Docker.

## Estructura

```
src/            pipeline: gmail, extract, store, aggregate, recurrence, bot, poller, dashboard
src/dashboard/  interfaz web estática (HTML, CSS, JS sin framework, analytics.js, motion.js)
scripts/        puntos de entrada de los comandos npm
tests/          pruebas con node:test
docs/           arquitectura.md, despliegue.md
```

Arquitectura, reglas de datos y algoritmo de recurrencia:
[docs/arquitectura.md](docs/arquitectura.md).

## Licencias de terceros

Las dependencias usan licencias permisivas (MIT, Apache-2.0, BSD-2-Clause), salvo
[GSAP](https://gsap.com/standard-license), que tiene su propia licencia "no charge". Se
instala desde npm, no se copia a este repositorio, y solo mueve animaciones opcionales
del dashboard. No es una licencia de código abierto aprobada por la OSI, así que revísala
si eso importa para tu uso.

## Licencia

[MIT](LICENSE) © 2026 Alex Varillas. Los issues y pull requests son bienvenidos; es un
proyecto de uso personal, así que las respuestas pueden tardar.
