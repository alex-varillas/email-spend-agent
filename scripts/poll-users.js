// Wrapper para correr el polling solo (sin el bot ni el servidor OAuth) —
// útil para pruebas manuales. En producción, run-bot.js ya lo levanta junto
// con el resto.
//
// Uso: npm run poll

import 'dotenv/config';
import { startPolling } from '../src/poller.js';

startPolling();
