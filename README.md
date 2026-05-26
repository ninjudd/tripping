# tripping

Chat frontends for [trip](https://github.com/ninjudd/trip) sessions.

Text your terminal from Telegram, Discord, or anywhere.

Each chat or channel gets its own `trip wrap` session. Messages become terminal input. Log output is relayed back as code blocks. The session is a real PTY — full TUI support, readline, colors, everything.

## Commands

All frontends share the same commands:

- `/new [command]` — start a new session
- `/enter <name>` — attach to existing session
- `/return` — switch back to previous session
- `/ls` — list sessions
- `/screen` — screenshot current session
- `/key <key>` — send key (enter, escape, tab, ctrl-c)
- `/kill <name>` — kill a session
- `/close` — end current session

Any other message is typed into the terminal.

## Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Copy `.env.example` to `.env` and add your `TELEGRAM_BOT_TOKEN`
3. `npm install && npm run telegram`

## Discord

1. Create an app at [discord.com/developers](https://discord.com/developers/applications)
2. Under Bot, enable **Message Content Intent**
3. Invite with scopes `bot` + `applications.commands`, permissions: Send Messages, Read Messages
4. Add your `DISCORD_BOT_TOKEN` to `.env`
5. `npm install && npm run discord`

## Requirements

- [trip](https://github.com/ninjudd/trip) installed and on PATH
- Node.js 18+
