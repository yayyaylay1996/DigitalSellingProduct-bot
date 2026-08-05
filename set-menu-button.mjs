/**
 * Point the bot's blue "Shop" menu button at your deployed Mini App.
 * Run locally after deploying the webapp:
 *   WEBAPP_URL="https://your-app.vercel.app" node set-menu-button.mjs
 * (or pass it as the first argument)
 */
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("Missing TELEGRAM_BOT_TOKEN in .env"); process.exit(1); }

const url = process.env.WEBAPP_URL || process.argv[2];
if (!url || !url.startsWith("https://")) {
  console.error('Provide an HTTPS Mini App URL, e.g.\n  WEBAPP_URL="https://your-app.vercel.app" node set-menu-button.mjs');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    menu_button: { type: "web_app", text: "🛍 Shop", web_app: { url } },
  }),
});
const data = await res.json();
if (data.ok) console.log(`✔ Shop button now opens: ${url}`);
else { console.error("Failed:", data); process.exit(1); }
