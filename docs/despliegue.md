# Despliegue en un servidor propio

Guía para dejar el agente corriendo 24/7 en una VPS Linux, con el dashboard accesible
solo por un canal privado.

> **Estado: sin validar de punta a punta en un servidor real.** Los pasos son estándar,
> pero revisa la salida de cada uno y corrige este documento con lo que falle. Los pull
> requests son bienvenidos.

## Decisiones de diseño

- **Un solo proceso.** `npm start` (`scripts/run-bot.js`) levanta el bot, el poller y el
  servidor HTTP del dashboard. Lo gestiona systemd.
- **Acceso privado.** No se abre ningún puerto salvo SSH. El bot de Telegram funciona
  igual porque hace *long polling*: es una conexión saliente y no necesita dominio ni
  puerto entrante.
- **Estado en disco.** Los gastos, la caché y los secretos viven en `data/`, `.cache/` y
  `.env`, fuera de Git. Necesitas disco persistente y copias de seguridad.

## Qué servidor elegir

Basta una VPS pequeña con **Ubuntu 24.04 LTS** (u otra distribución actual). El proceso
consume pocos recursos: **1 vCPU y 1 a 2 GB de RAM** alcanzan, y 2 GB dejan margen para
instalar dependencias. El costo real está en las llamadas a OpenAI, no en el servidor.
Cualquier proveedor sirve. Compara el precio total y elige un plan con copias de seguridad
si las ofrece. Crea el servidor con **autenticación por llave SSH**, no por contraseña, y
anota su IP (en esta guía, `IP_DEL_SERVIDOR`).

No sirve una plataforma serverless: el almacenamiento es un archivo local y el bot es un
proceso de larga duración.

## Antes de empezar

- Prueba todo en tu máquina primero: `npm test`, `npm run ingest -- 1` y `npm start`.
- Ten a mano tu `.env` completo, `data/` y `.cache/`.
- Telegram solo admite **un** consumidor de `getUpdates` por bot. Antes de arrancar el
  servicio, detén el bot en cualquier otro sitio donde corra con el mismo token, o el
  segundo proceso recibirá el error 409.
- `TELEGRAM_CHAT_ID` es obligatoria: el bot solo responde a ese chat y no arranca sin ella.

## 1. Endurecer el servidor (una vez)

```bash
# como root, recién creado el servidor
apt update && apt -y upgrade
adduser --disabled-password --gecos "" agent
install -d -m 700 -o agent -g agent /home/agent/.ssh
# Si tu llave pública quedó en /root/.ssh/authorized_keys:
install -m 600 -o agent -g agent /root/.ssh/authorized_keys /home/agent/.ssh/authorized_keys
```

Si tu proveedor usa otro usuario inicial o ese archivo no existe, instala tu llave pública
en `/home/agent/.ssh/authorized_keys` antes de seguir. **Abre otra terminal y comprueba
`ssh agent@IP_DEL_SERVIDOR` mientras la sesión inicial sigue abierta.**

```bash
# como root, solo después de comprobar el acceso de agent

# sin login por contraseña ni como root
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh

# firewall: solo SSH (el dashboard NO se abre; se entra por túnel)
ufw allow OpenSSH && ufw --force enable

# parches de seguridad automáticos
apt -y install unattended-upgrades
```

Vuelve a comprobar `ssh agent@IP_DEL_SERVIDOR` en otra terminal antes de cerrar la sesión
inicial. Si falla, revisa también los archivos de `/etc/ssh/sshd_config.d/` y no cierres la
sesión que todavía funciona.

## 2. Node y el código

```bash
# como root: Node 22 LTS (el proyecto pide 20 o superior)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs git

mkdir -p /opt/email-spend-agent && chown agent:agent /opt/email-spend-agent
sudo -u agent git clone https://github.com/alex-varillas/email-spend-agent.git /opt/email-spend-agent
cd /opt/email-spend-agent && sudo -u agent npm ci --omit=dev
```

Revisa el script de NodeSource antes de ejecutarlo si prefieres no encadenar `curl | bash`,
o instala Node con otro método que ya uses. Si trabajas desde un fork privado, crea en el
servidor una *deploy key* de solo lectura para ese repositorio y clónalo por SSH.

## 3. Copiar secretos y datos

`.env`, `data/` y `.cache/` no están en Git, a propósito. Se copian a mano desde tu máquina:

```bash
scp .env agent@IP_DEL_SERVIDOR:/opt/email-spend-agent/.env
scp -r data .cache agent@IP_DEL_SERVIDOR:/opt/email-spend-agent/
```

- **`.cache/extractions.json`** guarda lo que ya clasificó OpenAI por id de correo. Sin él,
  el paso 4 volvería a pagar por todo.
- **`data/`** contiene `gastos.json` y, con el tiempo, `seen-emails.json` y
  `subscription-alerts.json`. Copia la carpeta completa.
- En el `.env` del servidor deja vacías `GMAIL_WEB_CLIENT_ID`, `GMAIL_WEB_CLIENT_SECRET` y
  `PUBLIC_BASE_URL` (son del flujo multiusuario heredado) y añade `HOST=127.0.0.1`.
- Permisos, como `agent`: `chmod 600 /opt/email-spend-agent/.env` y
  `chmod -R go-rwx /opt/email-spend-agent/data /opt/email-spend-agent/.cache`.

## 4. Poner los datos al día

El poller solo revisa los últimos 3 días. Si tus datos locales son más viejos que eso, lo
ocurrido entre la última fecha y el primer arranque no entraría solo. Antes de levantar el
servicio:

```bash
cd /opt/email-spend-agent
sudo -u agent npm run ingest -- 3      # últimos 3 meses; reutiliza .cache y no duplica
```

El costo esperado son centavos, porque solo se clasifican los correos que no estén ya en la
caché. Al final comprueba que subió el total de registros y que el dashboard muestra datos
recientes.

## 5. Arrancar el servicio

`/etc/systemd/system/email-spend-agent.service`:

```ini
[Unit]
Description=email-spend-agent (bot de Telegram, poller y dashboard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
WorkingDirectory=/opt/email-spend-agent
ExecStart=/usr/bin/node scripts/run-bot.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now email-spend-agent
journalctl -u email-spend-agent -f     # debe mostrar el servidor escuchando en 127.0.0.1:3000
```

Prueba enviando `/gastos` y `/suscripciones` al bot.

## 6. Ver el dashboard (acceso privado)

Desde tu máquina, un túnel SSH que deja el puerto del servidor disponible solo para ti:

```bash
ssh -L 3000:127.0.0.1:3000 agent@IP_DEL_SERVIDOR
```

y abre `http://localhost:3000/dashboard` mientras el túnel esté abierto. Si el puerto 3000
local está ocupado, usa `-L 3100:127.0.0.1:3000` (el dashboard acepta el `Host` `localhost`).

Una alternativa más cómoda es **Tailscale** en el servidor y en tus dispositivos. En ese
caso añade el nombre del servidor a `DASHBOARD_ALLOWED_HOSTS` y ajusta `HOST` a la IP de
Tailscale, dejando el firewall cerrado a todo lo que no sea la interfaz `tailscale0`. Hazlo
solo si quieres entrar desde el teléfono.

## 7. Copias de seguridad

Lo que no está en Git es `data/`, `.env` y `.cache/`. La caché evita volver a pagar por
clasificaciones ya hechas. Un mínimo razonable:

```bash
# /etc/cron.d/email-spend-agent-backup: una copia diaria, conserva 7
0 4 * * * agent tar czf /home/agent/backup-$(date +\%a).tgz -C /opt/email-spend-agent data .env .cache && chmod 600 /home/agent/backup-*.tgz
```

Hay un nombre por día de la semana, así que cada copia sustituye a la de hace una semana. De
vez en cuando baja una a tu máquina con `scp`: una copia que vive solo en el mismo servidor
no protege de perderlo.

## 8. Actualizar

```bash
cd /opt/email-spend-agent
sudo -u agent git pull
sudo -u agent npm ci --omit=dev
systemctl restart email-spend-agent
```

## Pendientes conocidos

- **El dashboard no tiene login.** Es seguro mientras solo sea alcanzable por el túnel o por
  Tailscale (escucha en loopback y valida el `Host`). Exponerlo con un dominio requiere
  construir autenticación antes.
- **Sin monitoreo.** `Restart=always` levanta el proceso si cae, pero nada avisa si el poller
  deja de traer datos. El dashboard lo delata con un aviso de "sin gastos nuevos hace N
  días", sin alerta proactiva.
- **Sin imagen de Docker.** Una contribución para añadirla sería útil.
