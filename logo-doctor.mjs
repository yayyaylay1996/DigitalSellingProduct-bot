/**
 * Diagnose why the product logos aren't showing on the bot's buttons.
 *
 *   node logo-doctor.mjs
 *
 * Checks, in the order things can break:
 *   1. logo-emoji.json exists and has ids
 *   2. the custom emoji set still exists on Telegram and matches those ids
 *   3. whether the live bot runs on polling or a webhook
 *   4. sends a message built EXACTLY like the real menu, so what you see in
 *      Telegram is what the menu would render
 *
 * Step 4 is the one that matters. Telegram never errors when a bot isn't
 * allowed to use custom emoji — it silently swaps in the plain fallback — so
 * the only real test is looking at one.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

if (!TOKEN) { console.error("✗ Missing TELEGRAM_BOT_TOKEN in .env"); process.exit(1); }
if (!OWNER_ID) { console.error("✗ Missing ADMIN_CHAT_ID / TELEGRAM_CHAT_ID in .env"); process.exit(1); }

const API = `https://api.telegram.org/bot${TOKEN}`;

/** Same retry/diagnosis wrapper make-emoji-set.mjs uses: Node reports every
 *  transport failure as a bare "fetch failed", and a flaky link to Telegram
 *  usually succeeds on the second try. */
function netHint(err) {
  const code = err?.cause?.code || err?.code || "";
  const map = {
    ENOTFOUND: "DNS could not resolve api.telegram.org — offline, or DNS is blocked.",
    EAI_AGAIN: "DNS lookup timed out.",
    ECONNREFUSED: "Connection refused — something is blocking Telegram.",
    ECONNRESET: "Connection cut mid-request — flaky link or a VPN dropping.",
    ETIMEDOUT: "Timed out — Telegram is unreachable from this network.",
    UND_ERR_CONNECT_TIMEOUT: "Timed out — Telegram is unreachable from this network.",
  };
  return map[code] || (code ? `Network error (${code}).` : "Could not reach api.telegram.org.");
}

async function call(method, params = {}) {
  let res, last;
  for (let i = 1; i <= 3; i++) {
    try {
      res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(45000),
      });
      break;
    } catch (e) {
      last = e;
      if (i < 3) await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  if (!res) throw new Error(netHint(last));
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || `${method} failed`);
  return json.result;
}

const pass = (m) => console.log("  ✔ " + m);
const fail = (m) => console.log("  ✘ " + m);
const info = (m) => console.log("  · " + m);

async function main() {
  const me = await call("getMe");
  console.log(`\nBot: @${me.username}\n`);

  // ── 1. the map ──────────────────────────────────────────────────────────────
  console.log("1. logo-emoji.json");
  const ledgerPath = path.join(__dirname, "logo-emoji.json");
  if (!fs.existsSync(ledgerPath)) {
    fail("missing — run: node make-emoji-set.mjs");
    process.exit(1);
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
  const emoji = ledger.emoji || {};
  const names = Object.keys(emoji);
  if (names.length === 0) { fail("no ids in it — run: node make-emoji-set.mjs --reset"); process.exit(1); }
  pass(`${names.length} logos mapped (set "${ledger.setName}")`);

  // ── 2. the set still exists, and the ids are the live ones ─────────────────
  console.log("\n2. the custom emoji set on Telegram");
  let set;
  try {
    set = await call("getStickerSet", { name: ledger.setName });
    pass(`set exists, ${set.stickers.length} sticker(s)`);
  } catch (e) {
    fail(`${e.message} — run: node make-emoji-set.mjs --reset`);
    process.exit(1);
  }
  const live = new Set(set.stickers.map((s) => s.custom_emoji_id));
  const stale = names.filter((n) => !live.has(emoji[n]));
  if (stale.length) {
    fail(`${stale.length} id(s) in logo-emoji.json are not in the live set: ${stale.join(", ")}`);
    info("the set was rebuilt without regenerating the map — run: node make-emoji-set.mjs --reset");
  } else {
    pass("every id in logo-emoji.json is live");
  }

  // ── 3. how the deployed bot receives updates ───────────────────────────────
  console.log("\n3. how the live bot is running");
  const hook = await call("getWebhookInfo");
  if (hook.url) {
    info(`webhook → ${hook.url}`);
    if (hook.pending_update_count) info(`${hook.pending_update_count} update(s) queued`);
    if (hook.last_error_message) fail(`last webhook error: ${hook.last_error_message}`);
  } else {
    pass("polling (no webhook) — this is what index.js uses");
    info("if Railway is up, it holds the polling connection; running npm start locally would fight it");
  }

  // ── 4. the actual visual test ──────────────────────────────────────────────
  console.log("\n4. sending a live render test…");
  const sample = names.slice(0, 6);
  const rows = [];
  for (let i = 0; i < sample.length; i += 2) {
    rows.push(sample.slice(i, i + 2).map((n) => ({
      // Exactly the shape index.js builds for a product button.
      text: n,
      callback_data: "noop",
      icon_custom_emoji_id: emoji[n],
    })));
  }
  const inline = sample.map((n) => `<tg-emoji emoji-id="${emoji[n]}">🛍</tg-emoji>`).join(" ");

  await call("sendMessage", {
    chat_id: OWNER_ID,
    parse_mode: "HTML",
    text:
      `<b>Logo render test</b>\n\n` +
      `In text: ${inline}\n\n` +
      `On buttons: below 👇\n\n` +
      `<i>Real logos = everything works, and the only thing left is redeploying/restarting the bot.\n` +
      `Plain 🛍 = the account that owns @${me.username} does not have Telegram Premium active.</i>`,
    reply_markup: { inline_keyboard: rows },
  });
  pass("sent — go look at it in Telegram");

  console.log(`
─────────────────────────────────────────────────────────────
If that message shows REAL LOGOS:
  the code and the emoji set are both fine. The menu you are
  looking at is an OLD message — Telegram never re-renders a
  message that was already sent. Send /start to the bot to get
  a fresh menu. If it is still plain, Railway has not picked up
  commit a861f33 yet: open the Railway dashboard, check the
  Deployments tab, and redeploy if the latest build predates it.

If that message shows PLAIN 🛍:
  the bot is not allowed to use custom emoji. Confirm Telegram
  Premium is ACTIVE on the account that created @${me.username}
  in @BotFather — not on a different account, and not expired.
─────────────────────────────────────────────────────────────
`);
}

main().catch((e) => { console.error("\n✗ Failed:", e.message); process.exit(1); });
