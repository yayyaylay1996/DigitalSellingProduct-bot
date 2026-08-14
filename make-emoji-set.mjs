/**
 * Turn the 100x100 tiles in emoji-logos/ into a Telegram **custom emoji set**
 * owned by this bot, then write logo-emoji.json — the filename → custom_emoji_id
 * map that index.js reads to put real product logos on its buttons.
 *
 *   node make-emoji-set.mjs            # create or top up the set
 *   node make-emoji-set.mjs --reset    # delete the set and build it from scratch
 *
 * Requirements (Bot API 9.4, Feb 2026): the Telegram account that owns this bot
 * in @BotFather must have an active Telegram Premium subscription. Without it
 * Telegram accepts the sticker set but silently refuses to render the emoji, so
 * this script finishes by sending you a live test message — if the logos show up
 * there, they will show up on the buttons.
 *
 * Safe to re-run: existing logos are left alone and only new files are added.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILES_DIR = path.join(__dirname, "emoji-logos");
const LEDGER = path.join(__dirname, "logo-emoji.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// A sticker set has to be owned by a real Telegram user. ADMIN_CHAT_ID is what
// index.js uses, but this repo's .env predates that name and calls it
// TELEGRAM_CHAT_ID — accept either so nobody has to edit .env just for this.
const OWNER_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const RESET = process.argv.includes("--reset");

if (!TOKEN) die("Missing TELEGRAM_BOT_TOKEN in .env");
if (!OWNER_ID) die("Missing ADMIN_CHAT_ID (or TELEGRAM_CHAT_ID) in .env — the sticker set\n" +
  "  needs a human owner. Message @userinfobot on Telegram for your numeric id.");

const API = `https://api.telegram.org/bot${TOKEN}`;

/** The plain emoji Telegram shows to clients that can't render the custom one.
 *  Keyed by tile filename stem; anything unlisted falls back to 🛍. */
const FALLBACK_EMOJI = {
  netflix: "🎬", "youtube-premium": "▶️", spotify: "🎵", "amazon-prime": "📺",
  chatgpt: "🤖", claude: "🧠", gemini: "✨", perplexity: "🔎", "super-grok": "🤖",
  quillbot: "✍️", capcut: "🎞️", canva: "🎨", meitu: "📸",
  "alight-motion": "🎞️", wink: "🎞️", "elsa-speak-pro": "🗣️",
  zoom: "🎥", telegram: "✈️",
  outline: "🔒", "outline-vpn": "🔒", express: "🔒", windscribe: "🔒", happ: "🔒",
  "jump-jump": "🔒",
};

function die(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

/** Node's fetch throws a bare "fetch failed" for every transport problem, which
 *  tells you nothing. Unwrap the cause so a DNS failure reads differently from
 *  a timeout, and retry — reaching api.telegram.org over a flaky link or a VPN
 *  fails intermittently far more often than it fails for good. */
function netHint(err) {
  const code = err?.cause?.code || err?.code || "";
  const map = {
    ENOTFOUND: "DNS could not resolve api.telegram.org — you are offline, or DNS is being blocked.",
    EAI_AGAIN: "DNS lookup timed out — the connection is up but name resolution is failing.",
    ECONNREFUSED: "The connection was refused — something is blocking Telegram.",
    ECONNRESET: "The connection was cut mid-request — usually a flaky link or a VPN dropping.",
    ETIMEDOUT: "The connection timed out — Telegram is unreachable from this network.",
    UND_ERR_CONNECT_TIMEOUT: "Connecting timed out — Telegram is unreachable from this network.",
    CERT_HAS_EXPIRED: "TLS certificate rejected — check your system clock or any proxy.",
  };
  return map[code] || (code ? `Network error (${code}).` : "Could not reach api.telegram.org.");
}

async function fetchRetry(url, opts, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      last = e;
      if (i < tries) {
        console.log(`  … network attempt ${i}/${tries} failed, retrying in ${i * 3}s`);
        await new Promise((r) => setTimeout(r, i * 3000));
      }
    }
  }
  const err = new Error(netHint(last));
  err.isNetwork = true;
  throw err;
}

/** One Bot API call. `files` is { fieldName: absolutePath } for multipart uploads. */
async function call(method, params = {}, files = null) {
  let res;
  if (files) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    for (const [field, filePath] of Object.entries(files)) {
      const type = filePath.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
      form.append(field, new Blob([fs.readFileSync(filePath)], { type }), path.basename(filePath));
    }
    res = await fetchRetry(`${API}/${method}`, { method: "POST", body: form });
  } else {
    res = await fetchRetry(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  }
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.description || `${method} failed`);
    err.code = json.error_code;
    err.description = json.description || "";
    throw err;
  }
  return json.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── Which tiles are we publishing? ──────────────────────────────────────────
  if (!fs.existsSync(TILES_DIR)) die(`No emoji-logos/ folder at ${TILES_DIR}`);
  const all = fs.readdirSync(TILES_DIR);
  // WEBP is Telegram's documented format for static custom emoji, so it wins
  // whenever it's present. PNG stays supported for older tile folders.
  const webp = all.filter((f) => f.toLowerCase().endsWith(".webp")).sort();
  const tiles = webp.length ? webp : all.filter((f) => f.toLowerCase().endsWith(".png")).sort();
  if (tiles.length === 0) die("emoji-logos/ has no .webp or .png files.");
  console.log(`Format: ${webp.length ? "WEBP" : "PNG"}`);

  const me = await call("getMe");
  // Sticker set names are global and must end in _by_<botusername>.
  const setName = `shoplogos_by_${me.username}`;
  console.log(`Bot: @${me.username}`);
  console.log(`Set: ${setName}`);
  console.log(`Tiles: ${tiles.length}\n`);

  // ── Reset, if asked ─────────────────────────────────────────────────────────
  if (RESET) {
    try {
      await call("deleteStickerSet", { name: setName });
      console.log("• Deleted the existing set.");
      await sleep(1000);
    } catch (e) {
      console.log(`• Nothing to delete (${e.description || e.message}).`);
    }
    if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER);
  }

  // ── What's already published? ───────────────────────────────────────────────
  // The ledger records the exact order tiles were pushed, which is the same
  // order getStickerSet returns them in — that's how a filename is matched back
  // to its custom_emoji_id. Without it a re-run can't tell the stickers apart.
  let ledger = { setName, order: [], emoji: {} };
  if (fs.existsSync(LEDGER)) {
    try {
      const prev = JSON.parse(fs.readFileSync(LEDGER, "utf-8"));
      if (prev.setName === setName && Array.isArray(prev.order)) ledger = prev;
    } catch { /* corrupt ledger — rebuild from scratch below */ }
  }

  let setExists = true;
  try {
    await call("getStickerSet", { name: setName });
  } catch (e) {
    if (/not found|STICKERSET_INVALID/i.test(e.description)) setExists = false;
    else throw e;
  }

  if (setExists && ledger.order.length === 0) {
    die(`The set ${setName} already exists but logo-emoji.json is missing, so I\n` +
        `  can't tell which sticker is which logo. Re-run with --reset to rebuild it:\n` +
        `      node make-emoji-set.mjs --reset`);
  }

  // Multipart field names have to be plain identifiers, and the InputSticker's
  // "attach://" reference has to name that exact field.
  const fieldFor = (file) => path.parse(file).name.replace(/[^a-z0-9]/gi, "_");
  const inputFor = (file) => ({
    sticker: `attach://${fieldFor(file)}`,
    format: "static",
    emoji_list: [FALLBACK_EMOJI[path.parse(file).name] || "🛍"],
  });

  // ── Create the set, or append the tiles it doesn't have yet ─────────────────
  const pending = tiles.filter((f) => !ledger.order.includes(f));

  if (!setExists) {
    // splice, not slice: createNewStickerSet takes at most 50, and whatever is
    // left in `pending` afterwards gets appended one at a time below.
    const batch = pending.splice(0, 50);
    const files = Object.fromEntries(batch.map((f) => [fieldFor(f), path.join(TILES_DIR, f)]));
    try {
      await call("createNewStickerSet", {
        user_id: Number(OWNER_ID),
        name: setName,
        title: `${me.first_name} — Product Logos`,
        sticker_type: "custom_emoji",
        stickers: batch.map(inputFor),
      }, files);
    } catch (e) {
      if (/user_id_invalid|USER_ID_INVALID|not found/i.test(e.description)) {
        die(`Telegram rejected ADMIN_CHAT_ID=${OWNER_ID} as the set owner.\n` +
            `  Open a chat with @${me.username} from that account and send /start, then re-run.`);
      }
      throw e;
    }
    console.log(`✔ Created the set with ${batch.length} logo(s).`);
    ledger.order.push(...batch);
  }

  for (const f of pending) {
    await call("addStickerToSet", {
      user_id: Number(OWNER_ID),
      name: setName,
      sticker: inputFor(f),
    }, { [fieldFor(f)]: path.join(TILES_DIR, f) });
    ledger.order.push(f);
    console.log(`  + ${f}`);
    await sleep(400); // Telegram throttles rapid sticker uploads
  }

  // ── Read the ids back and write the map ─────────────────────────────────────
  const set = await call("getStickerSet", { name: setName });
  if (set.stickers.length !== ledger.order.length) {
    console.warn(`! Telegram reports ${set.stickers.length} stickers but the ledger has ` +
      `${ledger.order.length}. Re-run with --reset if the logos come out mismatched.`);
  }

  ledger.emoji = {};
  set.stickers.forEach((s, i) => {
    const file = ledger.order[i];
    if (!file || !s.custom_emoji_id) return;
    // Key on the lowercased stem so the sheet's Logo column matches whatever
    // extension it happens to use (capcut.png, netflix.jpg, canva.jpeg…).
    ledger.emoji[path.parse(file).name.toLowerCase()] = s.custom_emoji_id;
  });
  ledger.setName = setName;
  ledger.updated = new Date().toISOString();
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  console.log(`\n✔ Wrote logo-emoji.json — ${Object.keys(ledger.emoji).length} logo(s) mapped.`);

  // ── Live proof that the emoji actually render ───────────────────────────────
  // Telegram only renders custom emoji from a bot whose owner has Premium. It
  // does not error when they aren't allowed — the message just arrives with the
  // fallback emoji instead. So the only honest check is to look at one.
  const sample = Object.entries(ledger.emoji).slice(0, 8);
  const line = sample
    .map(([name, id]) => `<tg-emoji emoji-id="${id}">${FALLBACK_EMOJI[name] || "🛍"}</tg-emoji>`)
    .join(" ");
  try {
    await call("sendMessage", {
      chat_id: OWNER_ID,
      parse_mode: "HTML",
      text: `<b>Logo emoji test</b>\n\n${line}\n\n` +
        `If you see real logos above, you're done — restart the bot and the menu will use them.\n` +
        `If you see plain emoji instead, the account that owns this bot doesn't have ` +
        `Telegram Premium active.`,
      reply_markup: {
        inline_keyboard: [sample.slice(0, 2).map(([name, id]) => ({
          text: name, callback_data: "noop", icon_custom_emoji_id: id,
        }))],
      },
    });
    console.log("→ Sent you a test message on Telegram. Check that the logos render.");
  } catch (e) {
    console.warn(`! Could not send the test message: ${e.description || e.message}`);
  }

  console.log(`\nSet link: https://t.me/addemoji/${setName}`);
  console.log("Next: restart the bot (npm start) and open 🛍 Discover Products.");
}

main().catch((e) => {
  console.error("\n✗ Failed:", e.description || e.message);
  if (e.isNetwork) {
    console.error(`
  This never reached Telegram, so nothing was changed — the set and
  logo-emoji.json are exactly as they were. Things worth checking:

    • Is Telegram itself working right now on this Mac?
    • If you use a VPN to reach Telegram, is it connected? Turn it on
      (or off, if it is routing badly) and run the command again.
    • Try:  curl -s -o /dev/null -w "%{http_code}\\n" https://api.telegram.org
      200 or 302 means the network is fine and it is worth re-running.

  The script is safe to re-run as many times as you like.`);
  }
  process.exit(1);
});
