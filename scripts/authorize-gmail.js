// Script de un solo uso: obtiene el refresh token de Gmail para el pipeline.
//
// Requisitos previos (manuales, en Google Cloud Console):
//   1. Crear un proyecto en https://console.cloud.google.com
//   2. Habilitar la Gmail API para ese proyecto.
//   3. Configurar la pantalla de consentimiento OAuth en modo "Testing",
//      agregando tu propio correo como test user.
//   4. Crear credenciales OAuth de tipo "Desktop app", copiar el client id
//      y client secret a .env como GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET.
//
// Uso: npm run authorize-gmail
// Abre la URL que imprime, acepta el consentimiento con tu cuenta de Gmail,
// y el script imprime el refresh token para pegar en .env.

import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error(
    'Falta GMAIL_CLIENT_ID y/o GMAIL_CLIENT_SECRET en .env.\n' +
      'Crea las credenciales OAuth ("Desktop app") en Google Cloud Console y copialas a .env antes de correr este script.'
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // fuerza que Google reemita el refresh token
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404).end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Autorización rechazada.</h1> Puedes cerrar esta pestaña.');
    console.error(`Google devolvió un error: ${error}`);
    server.close(() => process.exit(1));
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Listo.</h1> Ya puedes cerrar esta pestaña y volver a la terminal.');

    if (!tokens.refresh_token) {
      console.error(
        '\nGoogle no devolvió un refresh token. Probablemente esta cuenta ya había ' +
          'autorizado la app antes.\nRevoca el acceso en https://myaccount.google.com/permissions ' +
          'y vuelve a correr este script.'
      );
      server.close(() => process.exit(1));
      return;
    }

    console.log('\nRefresh token obtenido. Copialo en .env como GMAIL_REFRESH_TOKEN:\n');
    console.log(tokens.refresh_token);
    console.log('');
    server.close(() => process.exit(0));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Error al intercambiar el código por tokens.</h1>');
    console.error('Error al intercambiar el código por tokens:', err.message);
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, () => {
  console.log('Abre esta URL en tu navegador y acepta el consentimiento con tu cuenta de Gmail:\n');
  console.log(authUrl);
  console.log(`\nEsperando el callback en ${REDIRECT_URI} ...`);
});
