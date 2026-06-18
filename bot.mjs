import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env file");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    "မင်္ဂလာပါ 👋\nWelcome to Going Forward Digital Shop!\n\nPlease choose a product category:\n\n1. ChatGPT / Claude / Gemini\n2. Netflix / YouTube / Amazon Prime\n3. VPN\n4. CapCut / Spotify"
  );
});

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "/start") return;

  bot.sendMessage(
    chatId,
    "Thank you. This is a test version of the digital product shop bot."
  );
});

console.log("Bot is running...");
