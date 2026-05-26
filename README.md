# tripping

Chat frontends for [trip](https://github.com/ninjudd/trip) sessions.

Text your terminal from Telegram, Discord, Slack, or anywhere.

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Copy `.env.example` to `.env` and add your token
3. Install and run:

```
npm install
npm run telegram
```

### Usage

- `/open claude` — start a session running claude
- `/open` — start a shell session
- `/screen` — screenshot the current terminal
- `/ctrl c` — send ctrl-c
- `/close` — end the session
- Any other message is typed into the terminal

### How it works

Each chat gets its own `trip wrap` session. Messages become `send` events. Log output is relayed back as code blocks. The session is a real PTY — full TUI support, readline, colors, everything.

## Requirements

- [trip](https://github.com/ninjudd/trip) installed and on PATH
- Node.js 18+
