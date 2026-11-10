// Punto de entrada único para producción: levanta el bot conversacional, el
// servidor HTTP privado y el polling de gastos nuevos en un solo proceso.

import 'dotenv/config';
import { startBotPolling } from '../src/bot.js';
import { startOAuthServer } from '../src/oauthServer.js';
import { startPolling } from '../src/poller.js';

startOAuthServer();
startBotPolling();
startPolling();
