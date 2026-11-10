// Levanta solo el dashboard (sin bot, poller ni OAuth), para verlo en local
// sin tocar Telegram. En producción lo sirve el mismo proceso de `npm start`.

import 'dotenv/config';
import http from 'node:http';
import { handleDashboardRequest } from '../src/dashboard.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (await handleDashboardRequest(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  })
  .listen(port, host, () => {
    console.log(`Dashboard en http://${host}:${port}/dashboard`);
  });
