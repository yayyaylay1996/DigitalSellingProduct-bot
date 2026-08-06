/**
 * Remove the Mini App from the bot's blue menu button, restoring Telegram's
 * default commands menu.
 *
 * Run locally:
 *   node remove-menu-button.mjs
 *
 * This only changes the button. The webapp/ folder and any Netlify deploy are
 * left alone — delete those separately if you want them gone for good.
 */
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("Missing TELEGRAM_BOT_TOKEN in .env"); process.exit(1); }

const res = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ menu_button: { type: "commands" } }),
});
const data = await res.json();
if (data.ok) {
  console.log("✔ Mini App removed — the menu button is back to the default commands menu.");
  console.log("  Customers now browse products through the bot's own menu only.");
} else {
  console.error("Failed:", data);
  process.exit(1);
}
