# email-spend-agent

A personal agent that reads your Gmail, detects every expense and recurring
subscription with an LLM, alerts you on Telegram and shows everything in a
private dashboard.

> Documentación completa en español: [README.es.md](README.es.md)

## What it does

- **Finds expenses in your inbox.** Receipts, card notices, bank transfers,
  wallet payments (Yape, Plin, Mercado Pago...) and cash withdrawals. Gmail
  access is read-only.
- **Extracts structured data with OpenAI.** Vendor, amount, currency, date,
  channel and category, using Structured Outputs.
- **Treats all money that leaves your bank accounts as an expense**, merges the
  same charge reported twice (merchant receipt plus card notice) and detects
  monthly and annual subscriptions.
- **Alerts you on Telegram.** New expense, new subscription, upcoming charge,
  possible cancellation, failed payment. You can also ask in plain language
  ("how much did I spend in August?") and get a summary plus an Excel file.
- **Private dashboard.** Charts, filters, subscriptions and a movements table,
  served on `127.0.0.1` only.

## Scope and status

- **One person, self-hosted.** This is not a hosted service and it is not
  multi-user.
- **Tuned for Peru and Argentina.** Bank and wallet lists, PEN/USD/ARS handling,
  and the LLM prompts and bot messages are in Spanish. To adapt it to another
  country, edit `BANK_PATTERNS` and the prompt in `src/extract.js`, and the
  keywords and known senders in `src/gmail.js`.
- **Version 0.1.0.** It runs well on a developer machine. The deployment guide in
  [docs/despliegue.md](docs/despliegue.md) has not been validated end to end on a
  real server yet; fixes are welcome.

## Requirements

- Node.js 20 or newer.
- A Google account and a Google Cloud project with the Gmail API enabled.
- An OpenAI API key (paid, usage-based).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A [Groq](https://console.groq.com) API key. Optional: it is only used to
  understand free-text questions in the bot. Without it, the `/gastos` and
  `/suscripciones` commands still work.

## Quick start

```bash
git clone https://github.com/alex-varillas/email-spend-agent.git
cd email-spend-agent
npm ci
cp .env.example .env        # then fill it in, see below
```

1. **Gmail.** In Google Cloud Console, enable the Gmail API, configure the OAuth
   consent screen and create an OAuth client of type **Desktop app**. Put its id
   and secret in `.env` (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`), then run
   `npm run authorize-gmail` and paste the refresh token it prints into
   `GMAIL_REFRESH_TOKEN`.
   While the consent screen is in **Testing** status, Google expires refresh
   tokens after 7 days. For long-term use, set the publishing status to **In
   production** (you will see an "unverified app" warning for your own account).
2. **OpenAI.** Set `OPENAI_API_KEY`. `OPENAI_MODEL` defaults to `gpt-4o-mini`.
3. **Telegram.** Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. Send
   the bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id`
   into `TELEGRAM_CHAT_ID`. The bot answers **only that chat** and will not start
   without it.
4. **Load your history** (calls OpenAI, so start with a short window):
   `npm run ingest -- 3` fetches the last 3 months and caches every extraction in
   `.cache/`, so re-running it does not pay twice.
5. **Run everything:** `npm start` launches the bot, the poller and the dashboard
   in one process. Open <http://localhost:3000/dashboard>.

Telegram allows a single `getUpdates` consumer per bot. Do not run `npm start`
on two machines with the same bot token.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Bot, poller and dashboard in one process (production entry point) |
| `npm run dashboard` | Dashboard only, on `http://127.0.0.1:3000/dashboard` |
| `npm run ingest -- [months] [max]` | Fetch, extract and store expenses (cached, resumable) |
| `npm run poll` | Poller only: checks for new emails every `POLL_INTERVAL_MINUTES` |
| `npm run preview -- [n]` | Dry run: extract and print a sample without saving |
| `npm run authorize-gmail` | One-time Gmail OAuth to get the refresh token |
| `npm test` | Full test suite (no network, no API keys needed) |

## Privacy and cost

- **Email text is sent to third parties.** Candidate emails go to OpenAI for
  extraction, and your Telegram questions go to Groq. Read their data policies.
- **Everything else stays on your machine**: expenses in `data/gastos.json`, the
  extraction cache in `.cache/`, secrets in `.env`. None of them is versioned.
- **OpenAI usage costs money.** Ingesting a year of mail is a one-off cost, and
  the poller only classifies new emails. Start with `npm run ingest -- 1`.

## Security

The dashboard has **no login** and listens on `127.0.0.1` only. Reach it through
an SSH tunnel or a private network such as Tailscale. Never bind it to `0.0.0.0`
or publish it on a domain without authentication in front. See
[SECURITY.md](SECURITY.md).

## Deploying

Any machine that can run Node.js 20+ with a persistent disk works: a small VPS,
a home server, a Raspberry Pi. The store is a local JSON file and the bot is a
long-running process, so serverless platforms are not a fit.
[docs/despliegue.md](docs/despliegue.md) walks through a VPS with systemd, an
SSH tunnel for the dashboard, and backups. There is no Docker image yet.

## Project layout

```
src/            pipeline: gmail, extract, store, aggregate, recurrence, bot, poller, dashboard
src/dashboard/  static web UI (HTML, CSS, vanilla JS, analytics.js, motion.js)
scripts/        entry points behind the npm scripts
tests/          node:test suites
docs/           arquitectura.md, despliegue.md
```

Architecture notes, data rules and the recurrence algorithm:
[docs/arquitectura.md](docs/arquitectura.md).

## Third-party licenses

Dependencies use permissive licenses (MIT, Apache-2.0, BSD-2-Clause), except
[GSAP](https://gsap.com/standard-license), which has its own "no charge"
license. It is installed from npm, not copied into this repository, and it only
drives optional dashboard animations. It is not an OSI-approved open source
license, so review it if that matters for your use.

## License

[MIT](LICENSE) © 2026 Alex Varillas. Issues and pull requests are welcome; this is
a personal-use project, so replies may take a while.
