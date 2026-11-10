# Arquitectura

Cómo está construido el agente, qué reglas de datos aplica y por qué. Para instalarlo
y usarlo, ver el [README](../README.es.md).

## Visión general

```
Gmail (solo lectura)
   │  src/gmail.js        busca correos candidatos
   ▼
OpenAI                    src/extract.js     un correo -> un JSON estructurado
   │
   ▼
data/gastos.json          src/store.js       persistencia, un registro por correo
   │
   ├─ src/aggregate.js    fusiona duplicados y agrupa por comercio
   ├─ src/recurrence.js   detecta suscripciones
   │
   ├─► src/poller.js ──► Telegram     avisos (gasto nuevo, suscripción, cobro próximo...)
   ├─► src/bot.js ─────► Telegram     consultas (/gastos, /suscripciones, texto libre)
   └─► src/dashboard.js ► navegador   panel local (127.0.0.1)
```

Todo corre en un solo proceso de Node.js (`npm start` → `scripts/run-bot.js`).

## Stack

- **Runtime:** Node.js 20+ con módulos ES, sin paso de compilación.
- **Extracción:** OpenAI (SDK `openai`) con Structured Outputs (`response_format:
  json_schema`, `strict: true`). Modelo configurable con `OPENAI_MODEL`.
- **Texto libre del bot:** Groq (SDK `groq-sdk`), modelo configurable con
  `GROQ_CHAT_MODEL`. Solo traduce una frase a un tipo de consulta y un rango de fechas.
- **Persistencia:** archivo JSON local. Un usuario y miles de registros al año no
  justifican una base de datos.
- **Por qué código y no un flujo visual (n8n u otros):** la lógica de recurrencia es la
  parte más delicada y se puede cubrir con pruebas automáticas e iterar rápido.

## Pipeline por módulo

1. **`gmail.js`** busca con la Gmail API (`googleapis`) en una ventana configurable
   (12 meses por defecto), combinando palabras clave de cobro y remitentes conocidos.
   La búsqueda solo acota candidatos; el filtro real lo hace `extract.js`. Devuelve
   también la hora real de recepción (`receivedAt`, de `internalDate`) para no depender
   del LLM para la hora.
2. **`extract.js`** hace una llamada a OpenAI por correo. El banco o procesador se
   detecta por el remitente con expresiones regulares (`BANK_PATTERNS`), no con el LLM:
   es gratis y determinista.
3. **`store.js`** guarda los gastos reales en `data/gastos.json`, indexados por id de
   correo, de modo que reingerir no duplica. Expone `filterGastos({from, to, categoria})`.
4. **`aggregate.js`** fusiona duplicados (`dedupeGastos`) y agrupa por comercio
   normalizado y moneda (`groupByVendor`).
5. **`recurrence.js`** detecta suscripciones (`detectRecurringGroups`) y filtra las que
   siguen vigentes (`filterActiveGroups`).
6. **`excel.js`** y **`report.js`** generan el Excel del bot y un PDF con el desglose
   de recurrentes. El PDF todavía no está conectado a ningún comando.
7. **`telegram.js`** envía mensajes y documentos con la Bot API usando `fetch`.
8. **`bot.js`** es el listener conversacional (long polling de `getUpdates`).
9. **`poller.js`** revisa correo nuevo cada ciclo y dispara los avisos.
10. **`subscriptionAlerts.js`** calcula los avisos que dependen de la fecha de hoy.
11. **`dashboard.js`** y `src/dashboard/` sirven el panel web.
12. **`seenEmails.js`** recuerda los correos ya clasificados como ruido, para no pagar
    de nuevo por el mismo boletín en cada ciclo del poller.

## Esquema de extracción

```json
{
  "es_cobro": true,
  "intento_fallido": false,
  "vendor": "string",
  "monto": 0,
  "moneda": "PEN | USD | ARS | ...",
  "fecha": "YYYY-MM-DD",
  "canal": "Yape | Plin | Mercado Pago | MODO | tarjeta | transferencia | Google Play | App Store | directo | cajero | otro",
  "categoria": "Suscripciones/Software | Entretenimiento | Comida | Transporte | Servicios | Salud | Educación | Compras | Transferencias personales | Retiros de efectivo | Otros"
}
```

Se agregan después, sin pasar por el LLM, `hora` (de `receivedAt`) y `banco` (del
remitente).

Reglas de clasificación que fija el prompt de `extract.js`:

- `es_cobro` es verdadero solo si el correo confirma dinero que ya se movió. Un boletín
  con precios, una oferta o un aviso de producto no cuenta, aunque muestre cifras.
- Un **retiro de efectivo** en cajero o agente cuenta como gasto: `es_cobro` verdadero,
  comercio "Retiro de efectivo", categoría "Retiros de efectivo", canal "cajero".
- `intento_fallido` es verdadero cuando el correo confirma un cobro que no se completó
  (rechazado, fondos insuficientes). Entonces `es_cobro` sigue en falso, pero se
  conservan comercio, monto, moneda y fecha para poder avisar.
- El símbolo `$` es ambiguo entre USD y ARS: se resuelve por el banco o la billetera, o
  por una mención explícita de moneda.

## Reglas de datos

### Duplicados

Un mismo cobro puede llegar por dos correos: el recibo del comercio y el aviso de
consumo del banco. `dedupeGastos` los fusiona cuando coinciden **fecha, monto y moneda**,
**al menos uno es un cargo de tarjeta** y los nombres de comercio comparten una palabra
significativa. Cada fusión se escribe en el log para poder auditarla. Es una heurística:
revisa el log si un total no te cuadra.

### Suscripciones

`detectRecurringGroups` marca un grupo (mismo comercio y moneda) como recurrente si:

- aparece **2 o más veces**;
- el intervalo es regular: **25 a 35 días** (mensual) o **350 a 380 días** (anual). Con
  varios intervalos basta que al menos el 60% lo sea;
- el monto es estable dentro de una tolerancia del **5%**, o cambia **una sola vez** y
  el nuevo monto se sostiene (un cambio en la última ocurrencia aún no cuenta).

Los **retiros de efectivo se excluyen**: un retiro mensual del mismo monto es un hábito,
no una suscripción.

`filterActiveGroups` descarta los grupos cuyo próximo cobro estimado lleva más de
**5 días** vencido sin renovarse. `poller.js` usa la detección sin filtrar a propósito,
porque necesita ver el grupo justo cuando cruza el umbral para avisar "posible
cancelación"; las consultas del usuario usan la versión filtrada.

### Monedas

Nunca se suman monedas distintas. Un registro sin moneda no entra a ningún total.

## Bot de Telegram

- Responde **solo al chat de `TELEGRAM_CHAT_ID`** y no arranca sin esa variable. Los
  demás chats se ignoran en silencio.
- `/gastos` y `/suscripciones` son comandos fijos. El texto libre pasa por Groq, que
  devuelve `{tipo, desde, hasta}`; el resto es lógica local sobre el store.
- `/gastos` responde con total, desglose por categoría y la parte recurrente, y adjunta
  un Excel con el detalle. `/suscripciones` responde solo en texto.

## Poller y avisos

Cada `POLL_INTERVAL_MINUTES` busca correos de los últimos 3 días que aún no se hayan
visto, los clasifica y avisa por Telegram de:

- gasto nuevo, suscripción nueva e intento de cobro fallido;
- **recordatorio** 1 o 2 días antes del próximo cobro estimado;
- **posible cancelación** cuando pasan 5 días del cobro esperado sin que llegue.

Los avisos que ya se enviaron se guardan en `data/subscription-alerts.json`, con una
clave atada a la fecha estimada, de modo que se vuelven a habilitar solos cuando el ciclo
de cobro avanza.

## Dashboard

Panel web de solo lectura con tus gastos, sin paso de compilación y sin librerías de
gráficas: las gráficas son SVG escritos a mano. Usa GSAP, servido desde el propio
servidor, para animaciones opcionales que se omiten con `prefers-reduced-motion`.

- **Acceso privado.** Escucha en `HOST=127.0.0.1` por defecto y solo acepta los `Host`
  `localhost`, `127.0.0.1` y los de `DASHBOARD_ALLOWED_HOSTS` (defensa contra DNS
  rebinding).
- **Rutas** (solo `GET`): `/dashboard` y `/dashboard/api/data`. La API devuelve los gastos
  ya deduplicados y las suscripciones vigentes, con el mismo tratamiento que el bot, para
  que los totales coincidan con Telegram. No expone el id del correo. Los archivos se
  sirven desde una lista cerrada, con una CSP estricta (`script-src 'self'`, sin inline).
- **Qué muestra.** Filtros (período, moneda, categoría, canal, banco, búsqueda, ocultar
  transferencias personales), indicadores con comparación contra el período anterior,
  gasto por mes o por día, rankings, suscripciones activas y una tabla de movimientos con
  detalle y exportación a CSV. Cada gráfica tiene vista de tabla y hay tema claro y
  oscuro. La URL admite parámetros, por ejemplo
  `?period=90&segment=categoria&dim=vendor&hide=1&currency=PEN&view=table`.

Reglas que conviene no romper:

- Nunca se suman monedas: se elige una (la más usada por defecto).
- El color sigue a la categoría, el canal o el banco y se calcula sobre el historial
  completo, no sobre el filtro activo. Más de 7 valores caen en "Otros" gris.
- La variación del total solo se muestra si el período anterior está cubierto por los
  datos.
- Con datos atrasados (último gasto hace más de 3 días) aparece un aviso, porque
  `filterActiveGroups` evalúa contra hoy.

La lógica de filtros y agregación está en `src/dashboard/analytics.js`, que no usa DOM ni
APIs de Node: la importan el navegador y las pruebas.

## Datos en disco

| Ruta | Contenido |
|---|---|
| `data/gastos.json` | Gastos e intentos fallidos, un registro por correo |
| `data/seen-emails.json` | Ids de correos ya clasificados como ruido |
| `data/subscription-alerts.json` | Avisos de suscripción ya enviados |
| `.cache/extractions.json` | Resultado de cada extracción por id de correo, para no pagar dos veces |

Todo queda fuera de Git. Haz copias de seguridad de `data/`, `.cache/` y `.env`.

## Código heredado del flujo multiusuario

`src/oauthServer.js`, `src/users.js`, `src/backfill.js` y el bucle de usuarios de
`poller.js` pertenecen a un flujo web (`/conectar`) en el que otras personas conectaban su
propio Gmail. Está **inactivo y sin soporte**: el bot ya no lo ofrece y el servidor HTTP
solo se usa para el dashboard. Se conserva por ahora y podría eliminarse más adelante.

## Pruebas

`npm test` ejecuta todo con `node:test`, sin red ni claves de API:

- `recurrence.test.js`: casos de referencia de dedupe y recurrencia (fusión de recibo y
  tarjeta con cambio de precio, suscripciones activas, una suscripción ya cancelada, ruido
  de transferencias entre personas y retiros de efectivo). Sus fixtures derivan de cobros
  reales con los nombres de personas sustituidos por ficticios.
- `subscriptionAlerts.test.js`: lógica de fechas de recordatorios y cobros no efectuados.
- `dashboard.test.js`: filtros, agregaciones, escalas y la validación de `Host`, la CSP y
  los archivos servidos.
- `bot.test.js`: el bot solo responde al chat autorizado.

## Limitaciones conocidas

- **Solo se lee el cuerpo del correo.** Si el monto está en un PDF adjunto o en una imagen,
  el registro puede quedar con monto 0 o nulo.
- **La deduplicación es una heurística.** Puede dejar pasar un duplicado si los nombres de
  comercio no comparten ninguna palabra.
- **Las transferencias entre personas generan ruido.** Se mitiga exigiendo patrón de monto
  e intervalo para considerar algo una suscripción, no solo el canal.
- **Los avisos dependen de que lleguen correos.** Si el banco deja de enviarlos, el agente
  no tiene cómo enterarse. El dashboard avisa cuando hace días que no entra nada.
