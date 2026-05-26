import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
} from "discord.js";
import { TripSession, TripEvent, tripLs, tripKill } from "../trip.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("Set DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}

interface ChannelState {
  session: TripSession;
  stack: string[];
}

const channels = new Map<string, ChannelState>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function sendCode(channelId: string, text: string) {
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;
  const display = text.length > 1900 ? text.slice(-1900) : text;
  (channel as { send: (msg: string) => Promise<unknown> })
    .send(`\`\`\`\n${display}\n\`\`\``)
    .catch(() => {});
}

function sendText(channelId: string, text: string) {
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;
  (channel as { send: (msg: string) => Promise<unknown> })
    .send(text)
    .catch(() => {});
}

function attachSession(
  channelId: string,
  name: string,
  command?: string[]
): TripSession {
  const old = channels.get(channelId);
  if (old) {
    old.session.close();
  }

  const session = new TripSession(name, command);
  const state: ChannelState = {
    session,
    stack: old ? [...old.stack, old.session.name] : [],
  };
  channels.set(channelId, state);

  session.on("log", (event: TripEvent) => {
    if (event.text) {
      sendCode(channelId, event.text);
    }
  });

  session.on("exit", (event: TripEvent) => {
    sendText(channelId, `Session exited (code ${event.code ?? "?"})`);
    channels.delete(channelId);
  });

  session.on("close", () => {
    channels.delete(channelId);
  });

  return session;
}

const commands = [
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a new session")
    .addStringOption((o) =>
      o.setName("command").setDescription("Command to run").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("enter")
    .setDescription("Attach to existing session")
    .addStringOption((o) =>
      o.setName("name").setDescription("Session name").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("return")
    .setDescription("Switch back to previous session"),
  new SlashCommandBuilder().setName("ls").setDescription("List sessions"),
  new SlashCommandBuilder()
    .setName("screen")
    .setDescription("Screenshot current session"),
  new SlashCommandBuilder()
    .setName("key")
    .setDescription("Send key (enter, escape, tab, ctrl-c)")
    .addStringOption((o) =>
      o.setName("key").setDescription("Key name").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("kill")
    .setDescription("Kill a session")
    .addStringOption((o) =>
      o.setName("name").setDescription("Session name").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("End current session"),
];

client.on("ready", async () => {
  console.log(`Tripping Discord bot logged in as ${client.user?.tag}`);

  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationCommands(client.user!.id), {
    body: commands.map((c) => c.toJSON()),
  });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const i = interaction as ChatInputCommandInteraction;
  const channelId = i.channelId;

  switch (i.commandName) {
    case "new": {
      const args = i.options.getString("command")?.trim();
      const command = args ? args.split(/\s+/) : undefined;
      const name = `discord-${channelId}`;
      attachSession(channelId, name, command);
      await i.reply(`Session started: ${command?.join(" ") ?? "$SHELL"}`);
      break;
    }

    case "enter": {
      const name = i.options.getString("name", true);
      attachSession(channelId, name);
      await i.reply(`Attached to ${name}`);
      break;
    }

    case "return": {
      const state = channels.get(channelId);
      if (!state || state.stack.length === 0) {
        await i.reply("No session to return to.");
        break;
      }
      const prev = state.stack.pop()!;
      state.session.close();
      attachSession(channelId, prev);
      await i.reply(`Returned to ${prev}`);
      break;
    }

    case "ls": {
      const output = await tripLs(true);
      if (output) {
        await i.reply(`\`\`\`\n${output}\n\`\`\``);
      } else {
        await i.reply("No sessions.");
      }
      break;
    }

    case "screen": {
      const state = channels.get(channelId);
      if (!state) {
        await i.reply("No active session. Use /new or /enter");
        break;
      }
      const text = await state.session.screenshot();
      const display = text.length > 1900 ? text.slice(-1900) : text;
      await i.reply(`\`\`\`\n${display}\n\`\`\``);
      break;
    }

    case "key": {
      const state = channels.get(channelId);
      if (!state) {
        await i.reply("No active session.");
        break;
      }
      const key = i.options.getString("key", true).toLowerCase();
      state.session.key(key);
      await i.reply({ content: `Sent: ${key}`, flags: 64 });
      break;
    }

    case "kill": {
      const name = i.options.getString("name", true);
      const result = await tripKill(name);
      await i.reply(result || `Killed ${name}`);
      break;
    }

    case "close": {
      const state = channels.get(channelId);
      if (!state) {
        await i.reply("No active session.");
        break;
      }
      state.session.close();
      channels.delete(channelId);
      await i.reply("Session closed.");
      break;
    }
  }
});

client.on("messageCreate", (message: Message) => {
  if (message.author.bot) return;
  const state = channels.get(message.channelId);
  if (!state) return;
  state.session.send(message.content + "\n");
});

client.login(token);
