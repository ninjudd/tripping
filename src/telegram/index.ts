import { Bot } from "grammy";
import { TripSession, TripEvent, tripLs, tripKill } from "../trip.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new Bot(token);

interface ChatState {
  session: TripSession;
  stack: string[];
}

const chats = new Map<number, ChatState>();

function reply(chatId: number, text: string) {
  bot.api.sendMessage(chatId, text).catch(() => {});
}

function replyCode(chatId: number, text: string) {
  const display = text.length > 4000 ? text.slice(-4000) : text;
  bot.api
    .sendMessage(chatId, `\`\`\`\n${display}\n\`\`\``, {
      parse_mode: "Markdown",
    })
    .catch(() => {});
}

function attachSession(chatId: number, name: string, command?: string[]) {
  const old = chats.get(chatId);
  if (old) {
    old.session.close();
  }

  const session = new TripSession(name, command);
  const state: ChatState = {
    session,
    stack: old ? [...old.stack, old.session.name] : [],
  };
  chats.set(chatId, state);

  session.on("log", (event: TripEvent) => {
    if (event.text) {
      replyCode(chatId, event.text);
    }
  });

  session.on("exit", (event: TripEvent) => {
    reply(chatId, `Session exited (code ${event.code ?? "?"})`);
    chats.delete(chatId);
  });

  session.on("close", () => {
    chats.delete(chatId);
  });

  return session;
}

bot.command("start", (ctx) => {
  ctx.reply(
    [
      "Commands:",
      "/new [command] — start a new session",
      "/enter <name> — attach to existing session",
      "/return — switch back to previous session",
      "/ls — list sessions",
      "/screen — screenshot current session",
      "/ctrl <key> — send control key",
      "/kill <name> — kill a session",
      "/close — end current session",
      "",
      "Messages are sent as terminal input.",
    ].join("\n")
  );
});

bot.command("new", (ctx) => {
  const args = ctx.match.trim();
  const command = args ? args.split(/\s+/) : undefined;
  const name = `telegram-${ctx.chat.id}`;
  attachSession(ctx.chat.id, name, command);
  ctx.reply(`Session started: ${command?.join(" ") ?? "$SHELL"}`);
});

bot.command("enter", (ctx) => {
  const name = ctx.match.trim();
  if (!name) {
    ctx.reply("Usage: /enter <session-name>");
    return;
  }
  attachSession(ctx.chat.id, name);
  ctx.reply(`Attached to ${name}`);
});

bot.command("return", (ctx) => {
  const state = chats.get(ctx.chat.id);
  if (!state || state.stack.length === 0) {
    ctx.reply("No session to return to.");
    return;
  }
  const prev = state.stack.pop()!;
  state.session.close();
  attachSession(ctx.chat.id, prev);
  ctx.reply(`Returned to ${prev}`);
});

bot.command("ls", async (ctx) => {
  const output = await tripLs(true);
  if (output) {
    replyCode(ctx.chat.id, output);
  } else {
    ctx.reply("No sessions.");
  }
});

bot.command("screen", async (ctx) => {
  const state = chats.get(ctx.chat.id);
  if (!state) {
    ctx.reply("No active session. /new or /enter <name>");
    return;
  }
  const text = await state.session.screenshot();
  replyCode(ctx.chat.id, text);
});

bot.command("ctrl", (ctx) => {
  const state = chats.get(ctx.chat.id);
  if (!state) {
    ctx.reply("No active session.");
    return;
  }
  const key = ctx.match.trim().toLowerCase();
  if (!key) {
    ctx.reply("Usage: /ctrl c, /ctrl d, /ctrl z");
    return;
  }
  state.session.key(`ctrl-${key}`);
});

bot.command("kill", async (ctx) => {
  const name = ctx.match.trim();
  if (!name) {
    ctx.reply("Usage: /kill <session-name>");
    return;
  }
  const result = await tripKill(name);
  ctx.reply(result || `Killed ${name}`);
});

bot.command("close", (ctx) => {
  const state = chats.get(ctx.chat.id);
  if (!state) {
    ctx.reply("No active session.");
    return;
  }
  state.session.close();
  chats.delete(ctx.chat.id);
  ctx.reply("Session closed.");
});

bot.on("message:text", (ctx) => {
  const state = chats.get(ctx.chat.id);
  if (!state) {
    return;
  }
  state.session.send(ctx.message.text + "\n");
});

bot.api.setMyCommands([
  { command: "new", description: "Start a new session" },
  { command: "enter", description: "Attach to existing session" },
  { command: "return", description: "Switch back to previous session" },
  { command: "ls", description: "List sessions" },
  { command: "screen", description: "Screenshot current session" },
  { command: "ctrl", description: "Send control key (e.g. /ctrl c)" },
  { command: "kill", description: "Kill a session" },
  { command: "close", description: "End current session" },
]);

bot.start();
console.log("Tripping bot started.");
