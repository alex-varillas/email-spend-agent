# Security

email-spend-agent reads your mailbox and stores your financial history, so it is
meant to run for **one person, on a machine you control**. This page lists what
it protects, what it does not, and how to report a problem.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
reporting instead: **Security > Report a vulnerability** on the repository page.
Never paste real tokens, `.env` contents, or `data/` files in an issue, even to
illustrate a bug. Redact them first.

## What is sensitive

| Item | Where it lives | Why it matters |
|---|---|---|
| `.env` | local file, ignored by git | Gmail refresh token, OpenAI, Groq and Telegram keys |
| `data/` | local folder, ignored by git | Your full expense history, plus `users.json` (refresh tokens) if the legacy flow was ever used |
| `.cache/` | local folder, ignored by git | Extraction results per email id |

None of these should ever be committed. If a token leaks, revoke it at the
provider (Google account permissions, the OpenAI and Groq consoles, `/revoke` in
@BotFather) and generate a new one.

## What the project already does

- **Gmail access is read-only** (`gmail.readonly`).
- **The dashboard listens on `127.0.0.1` only** and validates the `Host` header
  (against DNS rebinding). It serves a closed list of files with a strict CSP.
- **The Telegram bot answers a single chat**, the one in `TELEGRAM_CHAT_ID`, and
  refuses to start without it. Messages from any other chat are ignored.

## Known limits

- **The dashboard has no login.** It is safe only while it is reachable through an
  SSH tunnel or a private network such as Tailscale. Do not bind it to `0.0.0.0`
  or publish it on a domain without putting authentication in front of it.
- **Email text leaves your machine.** The body of candidate emails is sent to
  OpenAI for extraction, and your bot messages are sent to Groq for
  interpretation. Read their data policies before using this on a mailbox you
  care about.
- **Telegram is not end-to-end encrypted** for bots. Alerts and Excel reports sent
  by the bot pass through Telegram's servers.
- **Dependencies.** `npm audit` currently reports moderate-severity advisories in
  transitive dependencies (for example `uuid` through `exceljs`) whose fix needs a
  breaking change. They affect build-time and file-handling paths this tool does
  not expose to untrusted input, but run `npm audit` yourself before deploying.
- **The legacy multi-user OAuth flow** (`src/oauthServer.js`, `src/users.js`) is
  inactive and unsupported. Do not expose it.
