import { Bot } from "grammy";
import { TripSession, TripEvent } from "../trip.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new Bot(token);

const sessions = new Map<number, TripSession>();

bot.command("start", (ctx) => {
  ctx.reply(
    "Send /open <command> to start a session.\nExample: /open claude\n\nMessages are sent as input. Use /screen for a screenshot, /ctrl <key> for control keys, /close to end."
  );
});

bot.command("open", (ctx) => {
  const chatId = ctx.chat.id;

  if (sessions.has(chatId)) {
    ctx.reply("Session already open. /close first.");
    return;
  }

  const args = ctx.match.trim();
  const command = args ? args.split(/\s+/) : ["/bin/sh"];
  const name = `telegram-${chatId}`;

  const session = new TripSession(name, command);
  sessions.set(chatId, session);

  session.on("log", (event: TripEvent) => {
    if (event.text) {
      // Telegram has a 4096 char limit
      const text = event.text.length > 4000 ? event.text.slice(-4000) : event.text;
      ctx.reply(`\`\`\`\n${text}\n\`\`\``, { parse_mode: "Markdown" });
    }
  });

  session.on("exit", (event: TripEvent) => {
    ctx.reply(`Session exited (code ${event.code ?? "?"})`);
    sessions.delete(chatId);
  });

  session.on("close", () => {
    sessions.delete(chatId);
  });

  ctx.reply(`Session started: ${command.join(" ")}`);
});

bot.command("screen", async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session) {
    ctx.reply("No active session. /open <command>");
    return;
  }
  const text = await session.screenshot();
  const display = text.length > 4000 ? text.slice(-4000) : text;
  ctx.reply(`\`\`\`\n${display}\n\`\`\``, { parse_mode: "Markdown" });
});

bot.command("ctrl", (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session) {
    ctx.reply("No active session.");
    return;
  }
  const key = ctx.match.trim().toLowerCase();
  if (!key) {
    ctx.reply("Usage: /ctrl c, /ctrl d, /ctrl z");
    return;
  }
  session.key(`ctrl-${key}`);
});

bot.command("close", (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session) {
    ctx.reply("No active session.");
    return;
  }
  session.close();
  sessions.delete(ctx.chat.id);
  ctx.reply("Session closed.");
});

// Regular messages become input
bot.on("message:text", (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session) {
    return;
  }
  session.send(ctx.message.text + "\n");
});

bot.start();
console.log("Tripping bot started.");
