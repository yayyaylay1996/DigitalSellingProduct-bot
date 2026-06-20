import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { getProducts, logOrder, decreaseStock } from "./sheets.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Track users who are waiting to provide their email for "email" type products
// Map<chatId, { productName, callbackMessageId }>
const awaitingEmail = new Map();

// ─── /start command ──────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const products = await getProducts();
    if (products.length === 0) {
      return bot.sendMessage(chatId, "No products available right now. Check back later!");
    }

    const readyProducts = products.filter((p) => p.type === "ready" && p.stock > 0);
    const emailProducts = products.filter((p) => p.type === "email" && p.stock > 0);

    let text = "🛒 *Going Forward Digital Shop*\n\n";

    const keyboard = [];

    if (readyProducts.length > 0) {
      text += "📦 *Ready-Made Accounts*\n";
      readyProducts.forEach((p) => {
        text += `• ${p.name} — ${p.price} Ks\n`;
        keyboard.push([
          { text: `${p.name} (${p.price} Ks)`, callback_data: `buy_${p.name}` },
        ]);
      });
      text += "\n";
    }

    if (emailProducts.length > 0) {
      text += "📧 *Email-Based Activation*\n";
      emailProducts.forEach((p) => {
        text += `• ${p.name} — ${p.price} Ks\n`;
        keyboard.push([
          { text: `${p.name} (${p.price} Ks)`, callback_data: `buy_${p.name}` },
        ]);
      });
    }

    text += "\nTap a product below to order:";

    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    console.error("Error in /start:", err.message);
    bot.sendMessage(chatId, "⚠️ Failed to load products. Please try again.");
  }
});

// ─── Callback query handler (button taps) ────────────────────────────────────

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Answer the callback to remove the loading spinner
  await bot.answerCallbackQuery(query.id);

  if (!data.startsWith("buy_")) return;

  const productName = data.slice(4); // everything after "buy_"

  try {
    const products = await getProducts();
    const product = products.find((p) => p.name === productName);

    if (!product) {
      return bot.sendMessage(chatId, "❌ Product not found.");
    }

    if (product.stock <= 0) {
      return bot.sendMessage(chatId, `❌ Sorry, "${productName}" is out of stock.`);
    }

    if (product.type === "ready") {
      // ── Ready product: confirm immediately ──
      const customerLabel = query.from.username
        ? `@${query.from.username}`
        : `${query.from.first_name} (id:${query.from.id})`;

      await decreaseStock(productName);
      await logOrder({
        customerId: customerLabel,
        product: productName,
        email: "",
      });

      bot.sendMessage(
        chatId,
        `✅ *Order Confirmed!*\n\n` +
          `📦 Product: ${productName}\n` +
          `💰 Price: ${product.price} Ks\n\n` +
          `Your order is being processed. You'll receive your account details shortly.`,
        { parse_mode: "Markdown" }
      );
    } else if (product.type === "email") {
      // ── Email product: ask for their email ──
      awaitingEmail.set(chatId, { productName });

      bot.sendMessage(
        chatId,
        `📧 You selected *${productName}* (${product.price} Ks).\n\n` +
          `Please type the email address linked to your account so we can activate it:`,
        { parse_mode: "Markdown" }
      );
    }
  } catch (err) {
    console.error("Error handling callback:", err.message);
    bot.sendMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
});

// ─── Plain text handler (catches email replies) ──────────────────────────────

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Ignore commands
  if (!text || text.startsWith("/")) return;

  // Check if this user is in the email-collecting flow
  const pending = awaitingEmail.get(chatId);
  if (!pending) return;

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(text)) {
    return bot.sendMessage(chatId, "⚠️ That doesn't look like a valid email. Please try again:");
  }

  const email = text.trim();
  const productName = pending.productName;
  awaitingEmail.delete(chatId);

  try {
    const products = await getProducts();
    const product = products.find((p) => p.name === productName);

    if (!product || product.stock <= 0) {
      return bot.sendMessage(chatId, `❌ Sorry, "${productName}" is no longer available.`);
    }

    const customerLabel = msg.from.username
      ? `@${msg.from.username}`
      : `${msg.from.first_name} (id:${msg.from.id})`;

    await decreaseStock(productName);
    await logOrder({
      customerId: customerLabel,
      product: productName,
      email,
    });

    bot.sendMessage(
      chatId,
      `✅ *Order Confirmed!*\n\n` +
        `📦 Product: ${productName}\n` +
        `📧 Email: ${email}\n` +
        `💰 Price: ${product.price} Ks\n\n` +
        `Your account will be activated on ${email} shortly.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Error finalizing email order:", err.message);
    bot.sendMessage(chatId, "⚠️ Something went wrong. Please try /start to begin again.");
  }
});

console.log("🤖 Bot is running...");
