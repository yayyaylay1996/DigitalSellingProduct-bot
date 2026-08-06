import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import TelegramBot from "node-telegram-bot-api";
import {
  now,
  getSettings,
  setSetting,
  getProducts,
  getProductById,
  effectivePrice,
  resolveTips,
  getFaqsForProduct,
  getFaqByRow,
  countAvailableStock,
  getAvailableInventory,
  markInventorySold,
  createOrder,
  getMaxOrderNumber,
  getOrderByOrderId,
  getOrdersByChatId,
  getAllCustomerChatIds,
  updateOrderByOrderId,
  warmCache,
  getWalletBalance,
  reserveWalletTxId,
  creditWallet,
  chargeWallet,
  getWalletTransactions,
  ensureWalletTabs,
} from "./sheets.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

// Network hiccups talking to api.telegram.org (DNS blips, brief outages, VPN
// drops) should never kill the whole bot. Without these, an unhandled
// rejection or an unlistened "error" event crashes the process and every
// customer conversation with it — this is what was happening before.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (bot kept running):", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (bot kept running):", err?.message || err);
});

const bot = new TelegramBot(token, { polling: true });

// The polling loop retries on its own interval, but only if something is
// listening for its error events — otherwise a failed getUpdates() call (or,
// worse, Node's reserved "error" event with zero listeners) brings the
// process down instead of just logging and trying again.
bot.on("polling_error", (err) => {
  console.error("Telegram polling error (will keep retrying):", err.message);
});
bot.on("error", (err) => {
  console.error("Bot error:", err.message);
});

// Customers who have an order in "Awaiting Payslip" status and whose next photo
// should be treated as a payment slip.  Map<chatId, orderId> — same in-memory
// state pattern the old email flow used.
const awaitingPayslip = new Map();

// Orders are NOT written to the sheet until the admin taps Verified. From "Buy
// now" until that moment they live here in memory, keyed by the reserved Order
// ID (which is also the callback routing key). Cancelled / rejected / abandoned
// orders are simply dropped and never recorded.
const pendingOrders = new Map();

/** Reserve the next Order ID, accounting for both the sheet and any orders that
 *  are pending in memory, so two concurrent buyers never collide. */
async function reserveOrderId() {
  let max = await getMaxOrderNumber();
  for (const p of pendingOrders.values()) {
    const m = /ORD-(\d+)/i.exec(p.orderId || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `ORD-${String(max + 1).padStart(4, "0")}`;
}

// Canva guided-activation state, keyed by String(customerChatId):
//   { orderId, email, sent }.  In-memory like awaitingPayslip — a restart mid
//   flow loses it, same trade-off as the payslip state.
const canvaState = new Map();

// Wallet top-up requests, in memory until the admin approves them — mirrors
// pendingOrders exactly, just for WTX-xxxx ids instead of ORD-xxxx.
const pendingTopUps = new Map();
// Customers whose next photo should be treated as a top-up payslip (parallel
// to awaitingPayslip, which is for order payslips).
const awaitingTopupPayslip = new Map();
// Map<String(adminChatId), txId> — the admin confirmed a payslip and the bot
// is now waiting for them to type the amount off it. Keyed by admin chat id
// so confirming a second payslip before typing simply replaces the target;
// the prompt names the Ref each time so it stays unambiguous.
const awaitingAdminTopupAmount = new Map();

// The admin's numeric chat id. Telegram bots can only message a user by chat id,
// not by @username, so we resolve it from Settings ("Admin Chat ID") or capture
// it when the admin /starts the bot, then persist it back to the sheet.
let adminChatId = null;

async function resolveAdminChatId(settings) {
  // ADMIN_CHAT_ID wins over everything. A numeric chat ID cannot be spoofed,
  // whereas a Telegram @username can be released and re-registered by someone
  // else — so when this is set we never let the sheet or a message override it.
  if (process.env.ADMIN_CHAT_ID) return process.env.ADMIN_CHAT_ID;
  if (adminChatId) return adminChatId;
  const s = settings || (await getSettings());
  if (s["Admin Chat ID"]) {
    adminChatId = s["Admin Chat ID"];
    return adminChatId;
  }
  return null;
}

// Folder holding FAQ answer images (referenced by filename in the FAQ tab).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAQ_IMAGES_DIR = path.join(__dirname, "faq-images");

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Escape the few characters that matter when sending parse_mode "HTML". */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain-text price tag for inline buttons (no HTML): promo price when on sale,
 *  with the duration appended when present. e.g. "7,000 MMK 🎉 · 1 Month". */
function priceTag(p) {
  let tag = p.promo && p.promoPrice ? `${p.promoPrice} MMK 🎉` : `${p.price} MMK`;
  if (p.duration) tag += ` · ${p.duration}`;
  return tag;
}

/** Price line for a product. On a discounted promo, shows the original price
 *  struck through next to the promo price (HTML). Returns an HTML-safe string. */
function priceLine(product) {
  if (product.promo && product.promoPrice) {
    return `💰 <s>${esc(product.price)}</s> <b>${esc(product.promoPrice)} MMK</b> 🎉`;
  }
  return `💰 ${esc(product.price)} MMK`;
}

/** The admin's Telegram deep link (https://t.me/<username>) from Settings, or
 *  null when no username is configured. Used for "buy/contact admin directly". */
function adminUrl(s) {
  const u = (s["Admin Telegram Username"] || "").replace(/^@/, "").trim();
  return u ? `https://t.me/${u}` : null;
}

/** Build one inline-keyboard row per FAQ a product has. `backAction` is where
 *  the Back button should return ("name" or "detail"). Returns [] if no FAQs. */
async function faqButtonRows(product, backAction) {
  const faqs = await getFaqsForProduct(product);
  return faqs.map((f) => [
    { text: f.question, callback_data: `faq:${f.rowNumber}:${backAction}:${product.id}` },
  ]);
}

// ─── Persistent reply keyboard (bottom menu) ─────────────────────────────────

const BTN = {
  discover: "🛍 ကုန်ပစ္စည်းများ ကြည့်ရန်",
  promos: "🎉 ပရိုမိုးရှင်း",
  wallet: "👛 Wallet ကျန်ငွေ",
  contact: "📞 Admin ကို ဆက်သွယ်ရန်",
  history: "📜 Order မှတ်တမ်း",
  home: "🏠 ပင်မ Menu",
};

/** The always-visible bottom menu. Sent once on /start; Telegram keeps it shown. */
function mainKeyboard() {
  return {
    keyboard: [
      [{ text: BTN.discover }, { text: BTN.promos }],
      [{ text: BTN.wallet }, { text: BTN.contact }],
      [{ text: BTN.history }, { text: BTN.home }],
    ],
    resize_keyboard: true,
  };
}

// ─── Category headings ───────────────────────────────────────────────────────
// Telegram gives no control over inline-button colours — they follow the
// customer's own theme, so any per-category colour has to live in the button
// text itself. A coloured square there read as clutter rather than helping,
// so headings are now just a plain framed name.

/** Heading row text, e.g. "── Netflix ──". The rules shrink as the name grows
 *  so the row never wraps onto a second line on a narrow phone. */
function categoryHeading(cat) {
  const rule = "─".repeat(Math.max(2, Math.min(8, Math.round((20 - cat.length) / 2))));
  return `${rule} ${cat} ${rule}`;
}

// ─── Menu rendering ──────────────────────────────────────────────────────────

/** Main menu: products grouped under Category headings, two per row, each button
 *  prefixed with its Icon emoji. callback_data anchors on the first Product ID of
 *  each name group. A non-clickable header button ("noop") shows each category. */
async function sendMainMenu(chatId) {
  const products = await getProducts();
  if (products.length === 0) {
    return bot.sendMessage(chatId, "လောလောဆယ် ကုန်ပစ္စည်း မရှိသေးပါ။ နောက်မှ ပြန်ကြည့်ပေးပါနော် 🙏");
  }

  // One entry per unique Product Name, preserving sheet order, keeping category+icon.
  const seen = new Set();
  const uniques = [];
  for (const p of products) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    uniques.push(p);
  }

  // Group by category, preserving first-seen category order. Blank category → "Others".
  const order = [];
  const groups = new Map();
  for (const p of uniques) {
    const cat = p.category || "Others";
    if (!groups.has(cat)) {
      groups.set(cat, []);
      order.push(cat);
    }
    groups.get(cat).push(p);
  }

  const keyboard = [];
  for (const cat of order) {
    keyboard.push([{ text: categoryHeading(cat), callback_data: "noop" }]); // heading row
    const items = groups.get(cat);
    for (let i = 0; i < items.length; i += 2) {
      const row = items.slice(i, i + 2).map((p) => ({
        text: p.icon ? `${p.icon} ${p.name}` : p.name,
        callback_data: `name:${p.id}`,
      }));
      keyboard.push(row);
    }
  }

  await bot.sendMessage(
    chatId,
    "🛒 <b>Going Forward Digital Shop</b>\n\nကုန်ပစ္စည်း ရွေးချယ်ပါ 👇",
    { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } }
  );
}

/** Given any Product ID in a name group, show the variant list — or jump
 *  straight to the detail card if the name has only one variant. */
async function sendNameLevel(chatId, anchorId) {
  const products = await getProducts();
  const anchor = products.find((p) => p.id === anchorId);
  if (!anchor) return bot.sendMessage(chatId, "❌ ဒီကုန်ပစ္စည်းကို ရှာမတွေ့ပါ။");

  const group = products.filter((p) => p.name === anchor.name);
  if (group.length === 1) return sendDetailCard(chatId, group[0].id);

  const keyboard = group.map((p) => [
    { text: `${p.variant} — ${priceTag(p)}`, callback_data: `detail:${p.id}` },
  ]);
  for (const row of await faqButtonRows(anchor, "name")) keyboard.push(row);
  keyboard.push([{ text: "🏠 ပင်မ Menu", callback_data: "menu" }]);

  await bot.sendMessage(
    chatId,
    `<b>${esc(anchor.name)}</b>\n\nMonth / Package ရွေးချယ်ပါ 👇`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } }
  );
}

/** Detail card for one Product ID. Shows live stock for ready products; email
 *  products show no stock number and always allow Buy now. */
async function sendDetailCard(chatId, productId) {
  const products = await getProducts();
  const product = products.find((p) => p.id === productId);
  if (!product) return bot.sendMessage(chatId, "❌ ဒီကုန်ပစ္စည်းကို ရှာမတွေ့ပါ။");

  const group = products.filter((p) => p.name === product.name);
  const anchorId = group[0].id;
  const backData = group.length > 1 ? `name:${anchorId}` : "menu";

  // Title block: name and variant read as one unit, price on its own line so
  // it's the first thing the eye lands on after the name.
  let text = `<b>${esc(product.name)}</b>`;
  if (product.variant) text += `\n🏷 ${esc(product.variant)}`;
  let priceText = priceLine(product);
  if (product.duration) priceText += ` · ⏳ ${esc(product.duration)}`;
  text += `\n${priceText}`;

  // Description sits in its own paragraph, away from the title block.
  if (product.description) text += `\n\n${esc(product.description)}`;

  const keyboard = [];
  let buyable = true;
  let soldOut = false;

  if (product.type === "auto") {
    const stock = await countAvailableStock(product.id);
    if (stock > 0) {
      text += `\n\n📦 <b>လက်ကျန်</b> — ${stock} ခု`;
    } else {
      // Out of stock: show the Burmese notice + a "buy from admin directly" button.
      text += `\n\n⚠️ <b>Stock ကုန်နေပါသည်</b>\nAdmin မှ တဆင့် ဝယ်ယူပေးပါ`;
      buyable = false;
      soldOut = true;
    }
  }
  // manual products: no stock line, always buyable.

  if (buyable) {
    keyboard.push([{ text: "🛒 ဝယ်မယ်", callback_data: `buy:${product.id}` }]);
  }
  if (soldOut) {
    const s = await getSettings();
    const url = adminUrl(s);
    if (url) {
      keyboard.push([{ text: "🛒 Admin နှင့် တိုက်ရိုက်ဝယ်မည်", url }]);
    } else {
      keyboard.push([{ text: "🛒 Admin နှင့် တိုက်ရိုက်ဝယ်မည်", callback_data: "contact" }]);
    }
  }
  for (const row of await faqButtonRows(product, "detail")) keyboard.push(row);
  keyboard.push([
    { text: "⬅️ နောက်သို့", callback_data: backData },
    { text: "🏠 ပင်မ Menu", callback_data: "menu" },
  ]);

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ─── Promotions menu ─────────────────────────────────────────────────────────

/** List every product row currently flagged Promo = Yes. Each goes straight to
 *  its detail card. Shows the promo price on the button when discounted. */
async function sendPromotions(chatId) {
  const products = await getProducts();
  const promos = products.filter((p) => p.promo);
  if (promos.length === 0) {
    return bot.sendMessage(chatId, "🎉 လောလောဆယ် promotion မရှိသေးပါ။ နောက်မှ ပြန်ကြည့်ပေးပါနော်!");
  }
  const keyboard = promos.map((p) => {
    const label = p.variant ? `${p.name} — ${p.variant}` : p.name;
    return [{ text: `${label} · ${priceTag(p)}`, callback_data: `detail:${p.id}` }];
  });
  keyboard.push([{ text: "🏠 ပင်မ Menu", callback_data: "menu" }]);
  await bot.sendMessage(chatId, "🎉 <b>ပရိုမိုးရှင်း</b>\n\nအထူးလျှော့ဈေးများ 👇", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ─── Order history ───────────────────────────────────────────────────────────

/** Show the customer their recent orders (newest first, up to 10). */
async function handleOrderHistory(chatId) {
  const orders = await getOrdersByChatId(chatId, 10);
  if (orders.length === 0) {
    return bot.sendMessage(chatId, "📜 order မရှိသေးပါ။ 🛍 ကုန်ပစ္စည်းများကို ကြည့်ပြီး စတင်ဝယ်ယူနိုင်ပါတယ်!");
  }
  const lines = orders.map((o) => {
    const status = o.deliveryStatus || o.paymentStatus || "—";
    const variant = o.variant ? ` — ${o.variant}` : "";
    return (
      `<b>${esc(o.productName)}${esc(variant)}</b>\n` +
      `${esc(o.price)} MMK · ${esc(status)}\n` +
      `<i>${esc(o.orderId)} · ${esc(o.dateCreated)}</i>`
    );
  });
  await bot.sendMessage(
    chatId,
    `📜 <b>Order မှတ်တမ်း</b>\n━━━━━━━━━━━━━━━\n\n${lines.join("\n\n")}`,
    { parse_mode: "HTML" }
  );
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

/** Balance + recent activity, with a Top Up button. */
async function sendWalletMenu(chatId) {
  const balance = await getWalletBalance(chatId);
  const tx = await getWalletTransactions(chatId, 5);

  let text =
    `👛 <b>Wallet</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `လက်ကျန်ငွေ\n` +
    `<b>${balance.toLocaleString()} MMK</b>`;

  if (tx.length > 0) {
    text += `\n\n<b>နောက်ဆုံး လုပ်ဆောင်ချက်များ</b>\n`;
    for (const t of tx) {
      // "+" for top-ups, "−" for purchases, aligned so the eye can scan the
      // column rather than re-reading each line.
      const sign = t.amount >= 0 ? "➕" : "➖";
      const label = t.type === "TopUp" ? "ငွေဖြည့်" : "ဝယ်ယူ";
      text += `\n${sign} ${Math.abs(t.amount).toLocaleString()} MMK · ${esc(label)}\n<i>${esc(t.date)}</i>\n`;
    }
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ ငွေဖြည့်မယ် (Top Up)", callback_data: "topup" }],
        [{ text: "🏠 ပင်မ Menu", callback_data: "menu" }],
      ],
    },
  });
}

/** Tapped "Top Up": show the bank details straight away and wait for a
 *  screenshot. The customer never states an amount — the admin reads the real
 *  figure off the payslip after confirming it, which means a typo'd or
 *  optimistic number from the customer can't reach the ledger. */
async function startTopUpRequest(chatId, from) {
  const username = customerLabel(from);
  const txId = await reserveWalletTxId([...pendingTopUps.values()].map((p) => p.txId));
  pendingTopUps.set(txId, {
    txId,
    chatId,
    username,
    amount: null, // set by the admin after they confirm the screenshot
    dateCreated: now(),
    payslipReceived: false,
  });
  awaitingTopupPayslip.set(String(chatId), txId);

  const s = await getSettings();
  const note = (s["Payment Note Instruction"] || "").trim();
  const text = [
    `👛 <b>Wallet ငွေဖြည့်ခြင်း</b>`,
    `🧾 Ref: ${esc(txId)}`,
    ``,
    `━━━━━━━━━━━━━━━`,
    `<b>ငွေလွှဲရန် အချက်အလက်</b>`,
    ``,
    `💳 နည်းလမ်း`,
    `${esc(s["Accepted Payment Methods"] || "-")}`,
    ``,
    `🔢 အကောင့်နံပါတ်`,
    `<code>${esc(s["Bank Account Number"] || "-")}</code>`,
    ``,
    `👤 အကောင့်အမည်`,
    `${esc(s["Bank Account Name"] || "-")}`,
    note ? `\n📝 ${esc(note)}` : null,
    `━━━━━━━━━━━━━━━`,
    ``,
    `ငွေလွှဲပြီးရင် screenshot ကို ဒီမှာ ပို့ပေးပါ 📸`,
  ]
    .filter((l) => l !== null)
    .join("\n");
  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "❌ ပယ်ဖျက်မယ်", callback_data: `topupcancel:${txId}` }]] },
  });
}

function handleTopUpCancel(chatId, txId) {
  pendingTopUps.delete(txId);
  if (awaitingTopupPayslip.get(String(chatId)) === txId) awaitingTopupPayslip.delete(String(chatId));
  return bot.sendMessage(chatId, "Wallet ငွေဖြည့်ခြင်းကို ပယ်ဖျက်လိုက်ပါပြီ။");
}

/** Admin confirmed the payslip is real. Nothing is credited yet — the bot now
 *  asks the admin to type the amount shown on the slip, and the message
 *  handler below finishes the job. */
async function handleTopupVerify(query, pending) {
  const adminId = String(query.message.chat.id);
  awaitingAdminTopupAmount.set(adminId, pending.txId);
  await closeAdminMessage(query, "✅ Confirmed — awaiting amount");
  await bot.sendMessage(
    query.message.chat.id,
    `💰 How much was it? Send the amount for <b>${esc(pending.txId)}</b> ` +
      `(${customerMention(pending.username, pending.chatId)}) as a number.\n` +
      `Example: 15000`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✖️ Cancel this top-up", callback_data: `topupabort:${pending.txId}` }],
        ],
      },
    }
  );
}

/** The admin typed the amount: credit the wallet, confirm to both sides. */
async function finishTopupWithAmount(adminChatId, txId, amount) {
  const pending = pendingTopUps.get(txId);
  if (!pending) {
    awaitingAdminTopupAmount.delete(String(adminChatId));
    return bot.sendMessage(adminChatId, "ℹ️ That top-up was already handled or cancelled.");
  }

  pendingTopUps.delete(txId);
  awaitingAdminTopupAmount.delete(String(adminChatId));

  const newBalance = await creditWallet({
    chatId: pending.chatId,
    username: pending.username,
    amount,
    txId: pending.txId,
  });

  await bot.sendMessage(
    pending.chatId,
    `✅ <b>ငွေဖြည့်ခြင်း အောင်မြင်ပါပြီ</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `ဖြည့်သွင်းငွေ\n` +
      `<b>+ ${amount.toLocaleString()} MMK</b>\n\n` +
      `စုစုပေါင်း လက်ကျန်\n` +
      `<b>${newBalance.toLocaleString()} MMK</b>\n` +
      `━━━━━━━━━━━━━━━\n\n` +
      `🙏 ကျေးဇူးတင်ပါတယ်!`,
    { parse_mode: "HTML" }
  );
  await bot.sendMessage(
    adminChatId,
    `✅ Credited <b>${amount.toLocaleString()} MMK</b> to ` +
      `${customerMention(pending.username, pending.chatId)}.\n` +
      `New balance: <b>${newBalance.toLocaleString()} MMK</b> (${esc(pending.txId)})`,
    { parse_mode: "HTML" }
  );
}

/** Admin abandoned a confirmed top-up before entering the amount. */
function handleTopupAbort(adminChatId, txId) {
  pendingTopUps.delete(txId);
  awaitingAdminTopupAmount.delete(String(adminChatId));
  return bot.sendMessage(adminChatId, `✖️ Top-up ${txId} cancelled — nothing was credited.`);
}

/** Admin rejected a top-up payslip: no balance change, tell the customer. */
async function handleTopupNoVerify(query, pending) {
  pendingTopUps.delete(pending.txId);
  awaitingAdminTopupAmount.delete(String(query.message.chat.id));
  await bot.sendMessage(
    pending.chatId,
    `❌ ဝမ်းနည်းပါတယ်၊ Wallet ငွေဖြည့်ခြင်း (${pending.txId}) ကို အတည်ပြု၍ မရသေးပါ။ Admin ကို ဆက်သွယ်ပါ။`
  );
  await closeAdminMessage(query, "❌ Declined");
}

// ─── Product FAQ (per-product Q&A buttons) ───────────────────────────────────

/** Show one FAQ answer with a Back button. `arg` is "<faqRow>:<backAction>:<id>".
 *  When the FAQ row has an Image, the answer is sent as a photo from faq-images/;
 *  otherwise it's a text message. Back returns to the variant list or detail. */
async function handleFaq(chatId, arg) {
  const parts = arg.split(":");
  const faqRow = parts[0];
  const backAction = parts[1] || "name";
  const productId = parts[2] || "";
  const faq = await getFaqByRow(faqRow);
  if (!faq) {
    return productId ? sendNameLevel(chatId, productId) : sendMainMenu(chatId);
  }
  const backMarkup = {
    inline_keyboard: [[{ text: "⬅️ နောက်သို့", callback_data: `${backAction}:${productId}` }]],
  };

  if (faq.image) {
    const imgPath = path.join(FAQ_IMAGES_DIR, faq.image);
    if (fs.existsSync(imgPath)) {
      return bot.sendPhoto(chatId, fs.createReadStream(imgPath), {
        caption: faq.answer || undefined,
        reply_markup: backMarkup,
      });
    }
    console.warn(`FAQ image not found: ${imgPath}`);
    // Fall through to text if the image file is missing.
  }
  const fallback = faq.image
    ? `📷 “${faq.image}” ကို faq-images/ ထဲ ထည့်ဖို့ ကျန်နေပါသေးတယ်။`
    : "(no answer set)";
  await bot.sendMessage(chatId, faq.answer || fallback, { reply_markup: backMarkup });
}

// ─── Buy flow ────────────────────────────────────────────────────────────────

function customerLabel(from) {
  return from.username ? `@${from.username}` : `${from.first_name || "User"} (id:${from.id})`;
}

/**
 * A tappable reference to a customer, for messages sent to the admin.
 *
 * With a public @username we link to t.me/<username>. Without one — plenty of
 * customers never set a username — we fall back to a tg://user?id= mention,
 * which Telegram still renders as a tappable name. Either way the admin can
 * open the chat from the notification instead of copying a raw id by hand.
 *
 * Returns HTML, so the message must be sent with parse_mode: "HTML".
 */
function customerMention(label, chatId) {
  const m = /^@(\w+)/.exec((label || "").trim());
  if (m) return `<a href="https://t.me/${m[1]}">@${esc(m[1])}</a>`;

  const name = (label || "").replace(/\s*\(id:\d+\)\s*$/, "").trim() || "Customer";
  return chatId ? `<a href="tg://user?id=${chatId}">${esc(name)}</a>` : esc(name);
}

/**
 * An inline-keyboard row that opens the customer's chat, or null when they
 * have no public username. Telegram only accepts http(s) links in url
 * buttons, so the tg:// fallback above can't be used here — which is exactly
 * why the message body carries a mention too.
 */
function customerButtonRow(label, text = "💬 Message customer") {
  const url = customerUrl(label);
  return url ? [{ text, url }] : null;
}

/**
 * Forward the customer's own screenshot to the admin, then send the details
 * and action buttons underneath.
 *
 * Why forward instead of re-sending the photo by file_id: a forwarded message
 * carries a "Forwarded from" header that opens the sender's chat when tapped.
 * That is the only mechanism that reliably reaches a customer who has never
 * set a @username — a tg://user?id= mention only resolves if the admin's
 * client already knows that user, which for a first-time buyer it does not.
 *
 * If the customer has forwarding restricted in their privacy settings the
 * forward fails, so we fall back to sending the photo by file_id as before.
 */
async function sendPayslipToAdmin(adminId, msg, caption, keyboardRows) {
  let forwarded = false;
  try {
    await bot.forwardMessage(adminId, msg.chat.id, msg.message_id);
    forwarded = true;
  } catch (e) {
    console.warn("forwardMessage failed, falling back to file_id:", e.message);
  }

  if (!forwarded) {
    const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    await bot.sendPhoto(adminId, fileId, { caption, parse_mode: "HTML" });
    return bot.sendMessage(adminId, "👆 Payslip", {
      reply_markup: { inline_keyboard: keyboardRows },
    });
  }

  return bot.sendMessage(adminId, caption, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboardRows },
  });
}

/** Parse a price/amount cell that might have stray commas or spaces
 *  ("7,000") into a real number. NaN on anything unparseable — every wallet
 *  call site below treats NaN as "can't use the wallet here", never as 0. */
function toAmount(v) {
  return Number(String(v).replace(/[,\s]/g, ""));
}

/** Built as HTML. The account number and urgent phone are wrapped in <code> so
 *  Telegram renders them tap-to-copy (monospace = one-tap copy in the app). */
function buildPaymentInstructions(s, orderId, product, charged) {
  const note = (s["Payment Note Instruction"] || "").trim();
  const urgent = (s["Urgent Contact Phone"] || "").trim();
  return [
    `🧾 <b>Order ${esc(orderId)}</b>`,
    `📦 ${esc(product.name)}${product.variant ? ` — ${esc(product.variant)}` : ""}`,
    `💰 <b>${esc(charged)} MMK</b>`,
    ``,
    `━━━━━━━━━━━━━━━`,
    `<b>ငွေလွှဲရန် အချက်အလက်</b>`,
    ``,
    `💳 နည်းလမ်း`,
    `${esc(s["Accepted Payment Methods"] || "-")}`,
    ``,
    `🔢 အကောင့်နံပါတ်`,
    `<code>${esc(s["Bank Account Number"] || "-")}</code>`,
    ``,
    `👤 အကောင့်အမည်`,
    `${esc(s["Bank Account Name"] || "-")}`,
    note ? `\n📝 ${esc(note)}` : null,
    `━━━━━━━━━━━━━━━`,
    ``,
    `ငွေလွှဲပြီးရင် screenshot ကို ဒီမှာ ပို့ပေးပါ 📸`,
    urgent ? `\n☎️ အရေးပေါ် — <code>${esc(urgent)}</code>` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** Tapped "🛒 ဝယ်မယ်". Always offers both Wallet and Transfer Payment — the
 *  wallet balance no longer decides whether the button appears; it only
 *  decides what happens after they tap it (see handleBuyWallet). */
async function handleBuy(query, productId) {
  const chatId = query.message.chat.id;
  const product = await getProductById(productId);
  if (!product) return bot.sendMessage(chatId, "❌ ဒီကုန်ပစ္စည်းကို ရှာမတွေ့ပါ။");

  if (product.type === "auto") {
    const stock = await countAvailableStock(product.id);
    if (stock <= 0) {
      return bot.sendMessage(chatId, `❌ ဝမ်းနည်းပါတယ်၊ ${product.name} (${product.variant}) stock ကုန်သွားပါပြီ။`);
    }
  }

  const charged = toAmount(effectivePrice(product));
  const balance = await getWalletBalance(chatId);
  return bot.sendMessage(
    chatId,
    `<b>${esc(product.name)}</b>${product.variant ? `\n🏷 ${esc(product.variant)}` : ""}\n` +
      `💰 <b>${esc(charged.toLocaleString())} MMK</b>\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `ငွေပေးချေမှု နည်းလမ်း ရွေးချယ်ပါ 👇`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `👛 Pay with Wallet (လက်ကျန် ${balance.toLocaleString()} MMK)`,
              callback_data: `paywallet:${productId}`,
            },
          ],
          [{ text: "🏦 Transfer Payment (ဘဏ်လွှဲ / KPay)", callback_data: `paybank:${productId}` }],
          [{ text: "⬅️ နောက်သို့", callback_data: `detail:${productId}` }],
        ],
      },
    }
  );
}

/** The original flow: reserve an order, show bank/KPay payment instructions,
 *  wait for a payslip screenshot. Unchanged behaviour for anyone who picks
 *  this option or whose wallet can't cover the price. */
async function handleBuyBank(query, productId) {
  const chatId = query.message.chat.id;
  const product = await getProductById(productId);
  if (!product) return bot.sendMessage(chatId, "❌ ဒီကုန်ပစ္စည်းကို ရှာမတွေ့ပါ။");

  if (product.type === "auto") {
    const stock = await countAvailableStock(product.id);
    if (stock <= 0) {
      return bot.sendMessage(chatId, `❌ ဝမ်းနည်းပါတယ်၊ ${product.name} (${product.variant}) stock ကုန်သွားပါပြီ။`);
    }
  }

  const charged = effectivePrice(product); // promo price when on sale
  const username = customerLabel(query.from);

  // Reserve the Order ID and hold the order in memory — nothing is written to the
  // sheet yet. It's only recorded if/when the admin taps Verified.
  const orderId = await reserveOrderId();
  pendingOrders.set(orderId, {
    pendingId: orderId,
    orderId,
    dateCreated: now(),
    customerUsername: username,
    customerChatId: chatId,
    productId: product.id,
    productName: product.name,
    variant: product.variant,
    price: charged,
    payslipReceived: false,
  });
  awaitingPayslip.set(chatId, orderId);

  const s = await getSettings();
  await bot.sendMessage(chatId, buildPaymentInstructions(s, orderId, product, charged), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "❌ ပယ်ဖျက်မယ်", callback_data: `cancel:${orderId}` }],
        [{ text: "🏠 ပင်မ Menu", callback_data: "menu" }],
      ],
    },
  });
}

/** Tapped "Wallet" at checkout. Charges the wallet immediately and delivers
 *  right away — no payslip, no admin approval step — because the funds were
 *  already verified once, at top-up time. */
async function handleBuyWallet(query, productId) {
  const chatId = query.message.chat.id;
  const product = await getProductById(productId);
  if (!product) return bot.sendMessage(chatId, "❌ ဒီကုန်ပစ္စည်းကို ရှာမတွေ့ပါ။");

  // Shown from a Buy tap where balance wasn't yet known to be enough — check
  // up front before touching stock or reserving an order ID, so an obviously
  // short balance costs nothing but a message. Both this early check and the
  // race-guarded chargeWallet() below use the exact same text and buttons.
  const insufficientReply = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ ငွေဖြည့်မယ် (Top Up)", callback_data: "topup" }],
        [{ text: "🏦 Transfer Payment (ဘဏ်လွှဲ / KPay)", callback_data: `paybank:${productId}` }],
      ],
    },
  };

  const charged = toAmount(effectivePrice(product));
  const upfrontBalance = await getWalletBalance(chatId);
  if (upfrontBalance < charged) {
    return bot.sendMessage(chatId, "လက်ကျန်ငွေ မလုံလောက်ပါ", insufficientReply);
  }

  // For auto products, confirm stock BEFORE charging — a customer must never
  // pay for something that turns out to be sold out.
  let inv = null;
  if (product.type === "auto") {
    inv = await getAvailableInventory(product.id);
    if (!inv) {
      return bot.sendMessage(chatId, `❌ ဝမ်းနည်းပါတယ်၊ ${product.name} (${product.variant}) stock ကုန်သွားပါပြီ။`);
    }
  }

  const username = customerLabel(query.from);
  const orderId = await reserveOrderId();

  const newBalance = await chargeWallet({ chatId, username, amount: charged, orderId });
  if (newBalance === null) {
    // Balance changed between the check above and this write (e.g. two rapid
    // taps, or spent elsewhere in between) — don't silently do anything with
    // money, show the same insufficient-balance message again.
    return bot.sendMessage(chatId, "လက်ကျန်ငွေ မလုံလောက်ပါ", insufficientReply);
  }

  const base = {
    orderId,
    dateCreated: now(),
    customerUsername: username,
    customerChatId: chatId,
    productId: product.id,
    productName: product.name,
    variant: product.variant,
    price: charged,
  };
  const meta = {
    paymentStatus: "Paid (Wallet)",
    payslipSent: "N/A",
    adminDecision: "Auto (Wallet)",
    decisionTime: now(),
  };

  const s = await getSettings();
  const adminId = await resolveAdminChatId(s);
  if (product.type === "auto") {
    await deliverAutoOrder(base, product, inv, adminId, meta);
  } else {
    await deliverManualOrder(base, product, adminId, meta);
  }

  await bot.sendMessage(
    chatId,
    `👛 Wallet မှ ${charged.toLocaleString()} MMK နုတ်ယူပြီးပါပြီ။ လက်ကျန်: ${newBalance.toLocaleString()} MMK`
  );
}

async function handleCancel(query, pendingId) {
  const chatId = query.message.chat.id;
  pendingOrders.delete(pendingId); // never recorded to the sheet
  if (awaitingPayslip.get(chatId) === pendingId) awaitingPayslip.delete(chatId);
  await bot.sendMessage(chatId, "သင့် order ကို ပယ်ဖျက်လိုက်ပါပြီ။");
  await sendMainMenu(chatId);
}

// ─── Admin decisions ─────────────────────────────────────────────────────────

/** Append a status line to the admin's payslip message and remove its buttons so
 *  it can't be tapped twice.
 *
 *  Handles both message kinds: the buttons sit on a photo caption when the
 *  payslip was sent by file_id, but on a plain text message when the photo was
 *  forwarded (a forward can't carry a caption or keyboard of its own). Calling
 *  editMessageCaption on a text message fails, which would leave the buttons
 *  live and tappable a second time. */
async function closeAdminMessage(query, statusLabel) {
  const isPhoto = typeof query.message.caption === "string";
  try {
    if (isPhoto) {
      await bot.editMessageCaption(`${query.message.caption}\n\n${statusLabel}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      });
    } else {
      await bot.editMessageText(`${query.message.text || ""}\n\n${statusLabel}`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      });
    }
  } catch (e) {
    console.error("closeAdminMessage:", e.message);
    // Last resort: at least strip the buttons so the action can't be repeated.
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
    } catch (_) {
      /* nothing more we can do */
    }
  }
}

/** Same as closeAdminMessage but for a plain text admin message (not a photo). */
async function closeAdminText(query, statusLabel) {
  try {
    const original = query.message.text || "";
    await bot.editMessageText(`${original}\n\n${statusLabel}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  } catch (e) {
    console.error("closeAdminText:", e.message);
  }
}

// `pending` is the in-memory order (from Buy). On Verify we record it to the
// sheet for the first time; on No Verify / Cancel it's dropped, never recorded.
/** Instant delivery for an "auto" (ready-stock) product: records the order,
 *  sends the account credentials + tips, marks the inventory row Sold, and
 *  warns the admin if that was the last unit. `inv` must already be a
 *  confirmed-available row — this function does not re-check stock. Shared by
 *  the bank-transfer Verify path and the instant Wallet-payment path so a
 *  change to delivery logic only has to happen once. */
async function deliverAutoOrder(base, product, inv, adminId, meta) {
  const orderId = await createOrder({
    ...base,
    paymentStatus: meta.paymentStatus,
    payslipSent: meta.payslipSent,
    adminDecision: meta.adminDecision,
    decisionTime: meta.decisionTime,
    deliveryStatus: "Delivered",
    inventoryIdUsed: inv.inventoryId,
    credentialsSent: inv.credentials,
    usedDateTime: meta.decisionTime,
  });

  // Polished delivery card + per-product tips (Name|Variant → Name → Type).
  const tips = product ? await resolveTips(product) : "";
  const card = [
    `✅ <b>Order အောင်မြင်ပါပြီ!</b>`,
    ``,
    `📦 ${esc(base.productName)}${base.variant ? ` — ${esc(base.variant)}` : ""}`,
    `🧾 ${esc(orderId)}`,
    `💰 ${esc(base.price)} MMK`,
    ``,
    `━━━━━━━━━━━━━━━`,
    `🔐 <b>သင့်အကောင့် အချက်အလက်</b>`,
    ``,
    // Monospace makes the credentials tap-to-copy in Telegram and keeps them
    // visually separate from the surrounding message.
    `<code>${esc(inv.credentials)}</code>`,
    `━━━━━━━━━━━━━━━`,
    ``,
    // The moment the account is handed over — this is what the customer counts
    // their subscription from, so it goes on the delivery card itself rather
    // than only into the sheet.
    `🕒 <b>စတင်ချိန်</b>`,
    `${esc(meta.decisionTime)}`,
    product && product.duration ? `⏳ သက်တမ်း — ${esc(product.duration)}` : null,
  ].filter((l) => l !== null);
  if (tips) card.push(``, `💡 <b>အကြံပြုချက်</b>`, `<blockquote>${esc(tips)}</blockquote>`);
  card.push(``, `🙏 ဝယ်ယူအားပေးမှုအတွက် ကျေးဇူးတင်ပါတယ်!`);
  await bot.sendMessage(base.customerChatId, card.join("\n"), { parse_mode: "HTML" });

  await markInventorySold(inv.rowNumber, { soldTo: base.customerUsername, orderId });

  // Restock reminder: if that was the last available unit, ping the admin.
  const remaining = await countAvailableStock(product.id);
  if (remaining <= 0 && adminId) {
    await bot.sendMessage(
      adminId,
      `⚠️ <b>OUT OF STOCK</b>\n${esc(base.productName)}` +
        `${base.variant ? ` (${esc(base.variant)})` : ""} just sold its last unit. ` +
        `Please refill the Inventory sheet.`,
      { parse_mode: "HTML" }
    );
  }
  return orderId;
}

/** Hand-off delivery for a "manual" product: records the order, then either
 *  starts the Canva guided flow or sends the admin a "to set up" card and
 *  points the customer at the admin. Shared the same way as deliverAutoOrder
 *  above. */
async function deliverManualOrder(base, product, adminId, meta) {
  const orderId = await createOrder({
    ...base,
    paymentStatus: meta.paymentStatus,
    payslipSent: meta.payslipSent,
    adminDecision: meta.adminDecision,
    decisionTime: meta.decisionTime,
    deliveryStatus: "Awaiting Admin Contact",
  });
  const order = { ...base, orderId };

  // Canva has its own guided activation flow (email → invite → OK → expiry).
  if (isCanva(product)) {
    if (adminId) {
      await bot.sendMessage(
        adminId,
        `🛠 ${esc(meta.adminDecision)} Canva order ${esc(orderId)} — starting the guided setup with the customer now.`,
        { parse_mode: "HTML" }
      );
    }
    await startCanvaFlow(order);
    return orderId;
  }

  // Send the admin a clear "to handle" card — Product, Duration, option, time.
  const dur = product && product.duration ? product.duration : "";
  const adminCard = [
    `🛠 <b>Manual order to set up</b>`,
    `🧾 Order: ${esc(order.orderId)}`,
    `📦 Product: ${esc(order.productName)}`,
    dur ? `⏳ Duration: ${esc(dur)}` : null,
    `🏷 Option: ${esc(order.variant || "-")}`,
    `💰 Price: ${esc(order.price)} MMK`,
    `👤 Customer: ${customerMention(order.customerUsername, order.customerChatId)}`,
    `🕒 ${esc(meta.adminDecision)}: ${esc(meta.decisionTime)}`,
  ]
    .filter(Boolean)
    .join("\n");
  if (adminId) {
    const contact = customerButtonRow(order.customerUsername);
    await bot.sendMessage(adminId, adminCard, {
      parse_mode: "HTML",
      ...(contact ? { reply_markup: { inline_keyboard: [contact] } } : {}),
    });
  }

  // Customer button opens the admin chat directly (URL button, no bot ping).
  const s = await getSettings();
  const adminUser = (s["Admin Telegram Username"] || "").replace(/^@/, "");
  const customerMsg =
    `✅ ${order.productName} (${order.variant}) အတွက် ငွေလက်ခံရရှိပါပြီ!\n\n` +
    `Activation ဆက်လုပ်ရန် အောက်က Admin ကို ဆက်သွယ်ပေးပါ 👇`;
  if (adminUser) {
    await bot.sendMessage(order.customerChatId, customerMsg, {
      reply_markup: {
        inline_keyboard: [[{ text: "📩 Admin ကို ဆက်သွယ်မယ်", url: `https://t.me/${adminUser}` }]],
      },
    });
  } else {
    await bot.sendMessage(order.customerChatId, `${customerMsg}\n📞 ဖုန်း: ${s["Admin Contact Phone"] || "-"}`);
  }
  return orderId;
}

// `pending` is the in-memory order (from Buy). On Verify we record it to the
// sheet for the first time; on No Verify / Cancel it's dropped, never recorded.
async function handleVerify(query, pending) {
  const adminId = query.message.chat.id;
  const product = await getProductById(pending.productId);
  const type = product ? product.type : "auto";
  const base = {
    orderId: pending.orderId,
    dateCreated: pending.dateCreated,
    customerUsername: pending.customerUsername,
    customerChatId: pending.customerChatId,
    productId: pending.productId,
    productName: pending.productName,
    variant: pending.variant,
    price: pending.price,
  };
  const meta = {
    paymentStatus: "Paid",
    payslipSent: "Yes",
    adminDecision: "Verified",
    decisionTime: now(),
  };

  if (type === "auto") {
    const inv = await getAvailableInventory(pending.productId);
    if (!inv) {
      // Stop, keep it pending, leave the buttons so admin can retry after restocking.
      return bot.sendMessage(
        adminId,
        `⚠️ Sold out: no available inventory for ${pending.orderId} ` +
          `(${pending.productName} ${pending.variant}). Add stock, then tap Verified again.`
      );
    }
    pendingOrders.delete(pending.pendingId); // claim it
    await deliverAutoOrder(base, product, inv, adminId, meta);
  } else {
    pendingOrders.delete(pending.pendingId); // claim it
    await deliverManualOrder(base, product, adminId, meta);
  }

  await closeAdminMessage(query, "✅ Verified");
}

// No Verify: tell the customer, drop the pending order — nothing is recorded.
async function handleNoVerify(query, pending) {
  pendingOrders.delete(pending.pendingId);
  await bot.sendMessage(
    pending.customerChatId,
    `❌ ဝမ်းနည်းပါတယ်၊ ${pending.productName} (${pending.variant}) အတွက် ငွေပေးချေမှုကို အတည်ပြု၍ မရသေးပါ။`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 ပင်မ Menu", callback_data: "menu" }],
          [{ text: "📞 Admin ကို ဆက်သွယ်မယ်", callback_data: "contact" }],
        ],
      },
    }
  );
  await closeAdminMessage(query, "❌ No Verify");
}

// ─── Customer "contact admin" flows ──────────────────────────────────────────

async function handleContact(chatId) {
  const s = await getSettings();
  await bot.sendMessage(
    chatId,
    `အကူအညီလိုပါသလား? Admin ကို ဆက်သွယ်ပါ:\n` +
      `📞 ဖုန်း: ${s["Admin Contact Phone"] || "-"}\n` +
      `💬 Telegram: ${s["Admin Telegram Username"] || "-"}`
  );
}

// ─── Canva guided activation flow ────────────────────────────────────────────

/** True when this order is for the Canva product (its own multi-step flow). */
function isCanva(product) {
  return product && product.name.trim().toLowerCase() === "canva";
}

/** A https://t.me/<username> link for a customer, from the stored label
 *  ("@username" or "Name (id:123)"), or null when no @username is known. */
function customerUrl(label) {
  const m = /^@(\w+)/.exec((label || "").trim());
  return m ? `https://t.me/${m[1]}` : null;
}

/** Today + 1 year as DD.MM.YYYY (e.g. 02.07.2027). */
function expiryOneYear() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

const CANVA_MSG_A =
  "ငွေလက်ခံရရှိပါသည် \nCanva အကောင့်လုပ်ထားတဲ့ ကိုယ့်ရဲ့ Gmail ကို အရင်ပို့ပေးပါ၊၊ ပြီးမှ Send Gmail Invite ကိုနှိပ်ပါရှင်(password မလိုပါ) \n" +
  "🩵🩵မှတ်ချက် 🩵🩵\n" +
  "Gmail တစ်ကောင့်ကို ၁ခါပဲ invite လို့ရတာမို့ mail မပို့ခင် spelling/ အကြီးအသေး သေချာလေး စစ်ပြီးမှပို့ပေးပါနော်  🙏🏻🙏🏻🙏🏻";

const CANVA_MSG_C =
  "ပို့ထားတဲ့ gmail ရဲ့ inbox လေးစစ်ပေးပါရှင်😇 Invite ပို့ထားပါတယ် Join Team နှိပ်ပေးပါ\n" +
  "(Join မနှိပ်ခင် သတိပြုရန်💕💕💕)\n" +
  "👉🏻Canva application မှာဝင်ထားတဲ့ အကောင့်ဟာ invite လုပ်ထားတဲ့ gmail နဲ့ same gmail ဖြစ်ရပါမယ်( မဟုတ်ရင် Can't Join the Team ပေါ်မှာပါ) \n" +
  "ပြီးရင် OK button နှိပ်ပေးပါ instructions ဆက်ပြောပေးပါလိမ့်မယ်";

const CANVA_MSG_D =
  "https://t.me/goingforward_premium/115\n" +
  "အပေါ်က ကျွန်မတို့ Channel ရဲ့link လေးကို နှိပ်ပြီး join နည်း instruction တွေ ပုံနဲ့တကွ share ပေးထားပါတယ် \n" +
  "သိချင်တာ မေးချင်တာရှိရင် အချိန်မရွေး မေးလို့ရပါတယ်\n" +
  "Urgent call များအတွက် 09758230214 ကို ဆက်သွယ်နိုင်ပါတယ်နော် \n\n" +
  "Expired date : ";

const BTN_ADMIN_DIRECT = "💬 Admin နဲ့တိုက်ရိုက်ပြောမယ်";

/** Step 1: after Verify, ask the customer for their Canva gmail. */
async function startCanvaFlow(order) {
  const chatId = String(order.customerChatId);
  canvaState.set(chatId, { orderId: order.orderId, email: null, sent: false });
  const s = await getSettings();
  const url = adminUrl(s);
  const rows = [[{ text: "📧 Send Gmail Invite", callback_data: `canva_send:${order.orderId}` }]];
  if (url) rows.push([{ text: BTN_ADMIN_DIRECT, url }]);
  await bot.sendMessage(order.customerChatId, CANVA_MSG_A, {
    reply_markup: { inline_keyboard: rows },
  });
}

/** Step 2: customer tapped "Send Gmail Invite" — forward the captured email to
 *  the admin with Added / Contact-customer buttons. */
async function handleCanvaSend(query, orderId) {
  const chatId = String(query.message.chat.id);
  const st = canvaState.get(chatId);
  if (!st || !st.email) {
    return bot.sendMessage(
      query.message.chat.id,
      "✍️ Canva Gmail ကို အရင်ရိုက်ထည့်ပြီးမှ 📧 Send Gmail Invite ကို နှိပ်ပေးပါ။"
    );
  }
  if (st.sent) {
    return bot.sendMessage(query.message.chat.id, "✅ ပို့ပြီးပါပြီ — Admin ကို ခဏစောင့်ပေးပါနော် 🙏");
  }
  const order = await getOrderByOrderId(orderId);
  if (!order) return bot.sendMessage(query.message.chat.id, "❌ Order ကို ရှာမတွေ့ပါ။");
  st.sent = true;
  await updateOrderByOrderId(orderId, { notes: `Canva email: ${st.email}` });

  const s = await getSettings();
  const adminId = await resolveAdminChatId(s);
  const custUrl = customerUrl(order.customerUsername);
  const adminButtons = [[{ text: "✅ Added", callback_data: `canva_added:${orderId}` }]];
  if (custUrl) adminButtons.push([{ text: "💬 Contact the customer directly", url: custUrl }]);
  if (adminId) {
    await bot.sendMessage(
      adminId,
      `📧 <b>Canva invite request</b>\n` +
        `🧾 Order: ${esc(order.orderId)}\n` +
        `📦 ${esc(order.productName)} (${esc(order.variant)})\n` +
        `👤 Customer: ${customerMention(order.customerUsername, order.customerChatId)}\n` +
        `✉️ Gmail: <code>${esc(st.email)}</code>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: adminButtons } }
    );
  } else {
    console.warn(`No admin chat id known; cannot forward Canva email for ${orderId}.`);
  }
  await bot.sendMessage(query.message.chat.id, "✅ Admin ဆီ ပို့လိုက်ပါပြီ။ ခဏစောင့်ပေးပါနော် 🙏");
}

/** Step 3: admin tapped "Added" — tell the customer to check the invite. */
async function handleCanvaAdded(query, orderId) {
  const adminId = await resolveAdminChatId();
  if (!adminId || String(query.message.chat.id) !== String(adminId)) return; // admin only
  const order = await getOrderByOrderId(orderId);
  if (!order) return bot.sendMessage(query.message.chat.id, "❌ Order not found.");
  const s = await getSettings();
  const url = adminUrl(s);
  const rows = [[{ text: "OK", callback_data: `canva_ok:${orderId}` }]];
  if (url) rows.push([{ text: BTN_ADMIN_DIRECT, url }]);
  await bot.sendMessage(order.customerChatId, CANVA_MSG_C, {
    reply_markup: { inline_keyboard: rows },
  });
  await closeAdminText(query, "✅ Added");
}

/** Step 4: customer tapped "OK" — send the final join instructions + expiry. */
async function handleCanvaOk(query, orderId) {
  const chatId = query.message.chat.id;
  await bot.sendMessage(chatId, `${CANVA_MSG_D}${expiryOneYear()}`, {
    disable_web_page_preview: true,
  });
  await updateOrderByOrderId(orderId, { deliveryStatus: "Delivered" });
  canvaState.delete(String(chatId));
}

/** Capture the customer's typed Gmail while they're in the Canva flow. */
bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const st = canvaState.get(chatId);
  if (!st || st.sent) return; // not awaiting an email
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return; // ignore commands
  if (Object.values(BTN).includes(text)) return; // ignore menu button taps
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(text)) {
    return bot.sendMessage(msg.chat.id, "❌ မှန်ကန်တဲ့ Gmail တစ်ခု ရိုက်ထည့်ပေးပါ (ဥပမာ - yourname@gmail.com)။");
  }
  st.email = text;
  const s = await getSettings();
  const url = adminUrl(s);
  const rows = [[{ text: "📧 Send Gmail Invite", callback_data: `canva_send:${st.orderId}` }]];
  if (url) rows.push([{ text: BTN_ADMIN_DIRECT, url }]);
  await bot.sendMessage(msg.chat.id, `✅ လက်ခံရရှိပါပြီ: ${text}\n\nဆက်လက်ရန် 📧 Send Gmail Invite ကို နှိပ်ပေးပါ 👇`, {
    reply_markup: { inline_keyboard: rows },
  });
});

/** Capture the amount the ADMIN types after confirming a top-up payslip. Only
 *  fires for the admin, and only while a confirmed top-up is awaiting its
 *  figure — so ordinary admin chatter is never mistaken for an amount. */
bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const txId = awaitingAdminTopupAmount.get(chatId);
  if (!txId) return;

  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;
  if (Object.values(BTN).includes(text)) return; // menu tap, not an amount

  const amount = toAmount(text);
  if (!Number.isFinite(amount) || amount <= 0) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Send the amount as a number, e.g. 15000. (Top-up ${txId} is still waiting.)`
    );
  }
  try {
    await finishTopupWithAmount(msg.chat.id, txId, amount);
  } catch (err) {
    // Leave the state intact so the admin can simply retype the amount.
    console.error("finishTopupWithAmount:", err.message);
    bot.sendMessage(msg.chat.id, `⚠️ Could not credit that top-up: ${err.message}. Try sending the amount again.`);
  }
});

// ─── /start and "Products" ───────────────────────────────────────────────────

/** If this user's @username matches the Settings Admin Telegram Username, record
 *  their chat id (in memory + persisted to the sheet) so the bot can message them. */
async function maybeCaptureAdmin(msg) {
  // When ADMIN_CHAT_ID is configured, identity is settled by that number alone.
  // Skipping the username match here closes the hole where someone who claims
  // your old @username could take over the admin role and start receiving
  // payslips and approving orders.
  if (process.env.ADMIN_CHAT_ID) {
    return String(msg.chat.id) === String(process.env.ADMIN_CHAT_ID);
  }

  const s = await getSettings();
  const adminUser = (s["Admin Telegram Username"] || "").replace(/^@/, "").toLowerCase();
  const fromUser = (msg.from.username || "").toLowerCase();
  if (adminUser && fromUser && adminUser === fromUser) {
    if (String(adminChatId) !== String(msg.chat.id)) {
      adminChatId = msg.chat.id;
      try {
        await setSetting("Admin Chat ID", String(msg.chat.id));
        console.log(`Admin chat id captured and saved: ${msg.chat.id}`);
      } catch (e) {
        console.error("persist admin id:", e.message);
      }
    }
    return true;
  }
  return false;
}

async function handleStart(msg, payload) {
  const chatId = msg.chat.id;
  try {
    const isAdmin = await maybeCaptureAdmin(msg);
    if (isAdmin) {
      await bot.sendMessage(chatId, "✅ Admin registered. You'll receive payslips here.");
    }
    // Show the persistent bottom menu once; Telegram keeps it visible after.
    await bot.sendMessage(chatId, "👋 Going Forward Digital Shop မှ ကြိုဆိုပါတယ်!", {
      reply_markup: mainKeyboard(),
    });
    // Deep link from the Mini App: /start p_<ProductID> → jump to that product.
    if (payload && payload.startsWith("p_")) {
      return sendNameLevel(chatId, payload.slice(2));
    }
    await sendMainMenu(chatId);
  } catch (err) {
    console.error("Error in /start:", err.message);
    bot.sendMessage(chatId, "⚠️ ကုန်ပစ္စည်းများ ဖွင့်၍ မရသေးပါ။ ထပ်မံကြိုးစားပေးပါ။");
  }
}

bot.onText(/^\/start(?:\s+(\S+))?/, (msg, match) => handleStart(msg, match && match[1]));

// ─── Admin broadcast (/announce) ─────────────────────────────────────────────

/** Send `message` to every past customer, throttled, skipping anyone who has
 *  blocked the bot. Progress + a final tally are reported back to the admin. */
async function broadcast(adminId, message) {
  const ids = await getAllCustomerChatIds();
  if (ids.length === 0) {
    return bot.sendMessage(adminId, "No customers to announce to yet.");
  }
  await bot.sendMessage(adminId, `📣 Broadcasting to ${ids.length} customer(s)…`);
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      await bot.sendMessage(id, message, {
        reply_markup: {
          inline_keyboard: [[{ text: "🛍 ကုန်ပစ္စည်းများ ကြည့်ရန်", callback_data: "menu" }]],
        },
      });
      ok++;
    } catch (e) {
      fail++; // usually 403 = user blocked the bot; keep going
      console.warn(`broadcast to ${id} failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 60)); // ~16 msgs/sec, under Telegram limits
  }
  await bot.sendMessage(adminId, `✅ Done. Delivered: ${ok}, skipped/blocked: ${fail}.`);
}

/** /announce <message>  — admin only. With no message, sends a default new-arrivals note. */
bot.onText(/^\/announce(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  await maybeCaptureAdmin(msg); // registers admin if their username matches Settings
  const adminId = await resolveAdminChatId();
  if (!adminId || String(chatId) !== String(adminId)) return; // admin only — silent for others
  const text = match && match[1] ? match[1].trim() : "";
  const message = text || "🆕 ကုန်ပစ္စည်း အသစ်များ ရောက်ရှိနေပါပြီ! ကြည့်ရှုရန် အောက်ကို နှိပ်ပါ 👇";
  try {
    await broadcast(chatId, message);
  } catch (err) {
    console.error("broadcast error:", err.message);
    bot.sendMessage(chatId, "⚠️ Broadcast failed. Please try again.");
  }
});

// ─── Persistent menu button taps (text from the reply keyboard) ──────────────
bot.onText(/^\s*Products\s*$/i, (msg) => sendMainMenu(msg.chat.id));
bot.onText(new RegExp(`^${BTN.discover}$`), (msg) => sendMainMenu(msg.chat.id));
bot.onText(new RegExp(`^${BTN.home}$`), (msg) => sendMainMenu(msg.chat.id));
bot.onText(new RegExp(`^${BTN.promos}$`), (msg) => sendPromotions(msg.chat.id));
bot.onText(new RegExp(`^${BTN.contact}$`), (msg) => handleContact(msg.chat.id));
bot.onText(new RegExp(`^${BTN.history}$`), (msg) => handleOrderHistory(msg.chat.id));
bot.onText(new RegExp(`^${BTN.wallet}$`), async (msg) => {
  try {
    await sendWalletMenu(msg.chat.id);
  } catch (err) {
    console.error("sendWalletMenu:", err.message);
    bot.sendMessage(msg.chat.id, "⚠️ တစ်ခုခု မှားယွင်းသွားပါတယ်။ ထပ်မံကြိုးစားပေးပါ။");
  }
});

// ─── Callback queries (all button taps; callback_data is ID-based) ───────────

bot.on("callback_query", async (query) => {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const data = query.data || "";
  const sep = data.indexOf(":");
  const action = sep === -1 ? data : data.slice(0, sep);
  const arg = sep === -1 ? "" : data.slice(sep + 1);

  // Every branch below is `await`ed, not just `return`ed — returning a promise
  // from inside a try block does NOT let the catch below see it reject; only
  // an awaited rejection does. Without the await, an error deep in e.g.
  // handleBuy became a silent failure: nothing sent to the customer, nothing
  // but a console line, because the catch never actually fired.
  try {
    switch (action) {
      case "menu":
        return await sendMainMenu(chatId);
      case "name":
        return await sendNameLevel(chatId, arg);
      case "detail":
        return await sendDetailCard(chatId, arg);
      case "faq":
        return await handleFaq(chatId, arg);
      case "buy":
        return await handleBuy(query, arg);
      case "paybank":
        return await handleBuyBank(query, arg);
      case "paywallet":
        return await handleBuyWallet(query, arg);
      case "cancel":
        return await handleCancel(query, arg);
      case "verify":
      case "noverify": {
        const adminId = await resolveAdminChatId();
        if (!adminId || String(chatId) !== String(adminId)) return; // admin only
        const pending = pendingOrders.get(arg);
        if (!pending) {
          return await bot.sendMessage(chatId, "ℹ️ This order was already handled or cancelled.");
        }
        return action === "verify"
          ? await handleVerify(query, pending)
          : await handleNoVerify(query, pending);
      }
      case "topup":
        return await startTopUpRequest(chatId, query.from);
      case "topupcancel":
        return await handleTopUpCancel(chatId, arg);
      case "topupabort": {
        const adminId = await resolveAdminChatId();
        if (!adminId || String(chatId) !== String(adminId)) return; // admin only
        return await handleTopupAbort(chatId, arg);
      }
      case "topupverify":
      case "topupnoverify": {
        const adminId = await resolveAdminChatId();
        if (!adminId || String(chatId) !== String(adminId)) return; // admin only
        const pendingTx = pendingTopUps.get(arg);
        if (!pendingTx) {
          return await bot.sendMessage(chatId, "ℹ️ This top-up was already handled or cancelled.");
        }
        return action === "topupverify"
          ? await handleTopupVerify(query, pendingTx)
          : await handleTopupNoVerify(query, pendingTx);
      }
      case "contact":
        return await handleContact(chatId);
      case "canva_send":
        return await handleCanvaSend(query, arg);
      case "canva_added":
        return await handleCanvaAdded(query, arg);
      case "canva_ok":
        return await handleCanvaOk(query, arg);
      case "noop":
        return; // category heading — not clickable
      default:
        return;
    }
  } catch (err) {
    console.error(`Error handling callback "${data}":`, err.message);
    bot.sendMessage(chatId, "⚠️ တစ်ခုခု မှားယွင်းသွားပါတယ်။ ထပ်မံကြိုးစားပေးပါ။");
    // Also tell the admin what actually broke. The customer gets a friendly
    // line; without this the real reason only ever reached the server log,
    // which is invisible once the bot runs on a host rather than a laptop.
    try {
      const adminId = await resolveAdminChatId();
      if (adminId && String(adminId) !== String(chatId)) {
        await bot.sendMessage(adminId, `⚠️ Bot error on "${data}": ${err.message}`);
      }
    } catch (_) {
      /* never let error reporting throw */
    }
  }
});

// ─── Payslip photos ──────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const pendingId = awaitingPayslip.get(chatId);
  if (!pendingId) return handleTopupPhoto(msg); // not an order payslip — maybe a top-up one

  const pending = pendingOrders.get(pendingId);
  if (!pending || pending.payslipReceived) {
    awaitingPayslip.delete(chatId);
    return;
  }

  try {
    pending.payslipReceived = true; // forward once
    awaitingPayslip.delete(chatId);

    const s = await getSettings();
    const adminId = await resolveAdminChatId(s);
    const caption = [
      `🧾 <b>New payslip</b>`,
      `🕒 ${esc(now())}`, // when the payslip actually arrived
      ``,
      `Order: ${esc(pending.orderId)}`,
      `Product: ${esc(pending.productName)} (${esc(pending.variant)})`,
      `Price: ${esc(pending.price)} MMK`,
      `Customer: ${customerMention(pending.customerUsername, pending.customerChatId)}`,
      `<i>Tap the “Forwarded from” name above to open their chat.</i>`,
    ].join("\n");

    if (adminId) {
      const rows = [
        [
          { text: "✅ Verified", callback_data: `verify:${pending.orderId}` },
          { text: "❌ No Verify", callback_data: `noverify:${pending.orderId}` },
        ],
      ];
      const contact = customerButtonRow(pending.customerUsername);
      if (contact) rows.push(contact);

      await sendPayslipToAdmin(adminId, msg, caption, rows);
    } else {
      console.warn(
        `No admin chat id known; cannot forward payslip for ${pending.orderId}. ` +
          `Admin must send /start to the bot first.`
      );
    }

    await bot.sendMessage(chatId, "✅ ငွေလွှဲ screenshot လက်ခံရရှိပါပြီ။ Admin မှ အတည်ပြုမှုကို ခဏစောင့်ပေးပါနော် 🙏");
  } catch (err) {
    pending.payslipReceived = false; // allow a retry on failure
    console.error("payslip error:", err.message);
    bot.sendMessage(chatId, "⚠️ တစ်ခုခု မှားယွင်းသွားပါတယ်။ ထပ်မံကြိုးစားပေးပါ။");
  }
});

/** Same shape as the order-payslip handler above, for a wallet top-up
 *  request instead of a product order. Called from the "photo" listener when
 *  the customer isn't mid-checkout. */
async function handleTopupPhoto(msg) {
  const chatId = msg.chat.id;
  const txId = awaitingTopupPayslip.get(String(chatId));
  if (!txId) return; // not awaiting anything — ignore

  const pending = pendingTopUps.get(txId);
  if (!pending || pending.payslipReceived) {
    awaitingTopupPayslip.delete(String(chatId));
    return;
  }

  try {
    pending.payslipReceived = true;
    awaitingTopupPayslip.delete(String(chatId));

    const s = await getSettings();
    const adminId = await resolveAdminChatId(s);
    // No amount line — the customer never declared one. The admin reads the
    // figure off the screenshot and types it after confirming.
    const caption = [
      `👛 <b>Wallet top-up request</b>`,
      `🕒 ${esc(now())}`, // when the payslip actually arrived
      ``,
      `Ref: ${esc(pending.txId)}`,
      `Customer: ${customerMention(pending.username, pending.chatId)}`,
      `<i>Tap the “Forwarded from” name above to open their chat.</i>`,
      ``,
      `Confirm, then send the amount shown on the slip.`,
    ].join("\n");

    if (adminId) {
      const rows = [
        [
          { text: "✅ Confirm", callback_data: `topupverify:${pending.txId}` },
          { text: "❌ Decline", callback_data: `topupnoverify:${pending.txId}` },
        ],
      ];
      const contact = customerButtonRow(pending.username);
      if (contact) rows.push(contact);

      await sendPayslipToAdmin(adminId, msg, caption, rows);
    } else {
      console.warn(
        `No admin chat id known; cannot forward top-up for ${pending.txId}. ` +
          `Admin must send /start to the bot first.`
      );
    }

    await bot.sendMessage(chatId, "✅ ငွေလွှဲ screenshot လက်ခံရရှိပါပြီ။ Admin မှ အတည်ပြုမှုကို ခဏစောင့်ပေးပါနော် 🙏");
  } catch (err) {
    pending.payslipReceived = false;
    console.error("topup payslip error:", err.message);
    bot.sendMessage(chatId, "⚠️ တစ်ခုခု မှားယွင်းသွားပါတယ်။ ထပ်မံကြိုးစားပေးပါ။");
  }
}

// Load the read-mostly tabs once at boot. Without this, whoever taps first
// after a restart waits on three or four cold Sheets calls.
warmCache().then(() => console.log("📦 Sheet cache warmed"));

// Create the wallet tabs now if they're missing, so the first customer to tap
// Top Up isn't the one who discovers they aren't there.
ensureWalletTabs()
  .then(() => console.log("👛 Wallet tabs ready"))
  .catch((e) => console.error("⚠️ Wallet tabs unavailable:", e.message));

console.log("🤖 Bot is running...");
