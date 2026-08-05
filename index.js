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
  contact: "📞 Admin ကို ဆက်သွယ်ရန်",
  history: "📜 Order မှတ်တမ်း",
  home: "🏠 ပင်မ Menu",
};

/** The always-visible bottom menu. Sent once on /start; Telegram keeps it shown. */
function mainKeyboard() {
  return {
    keyboard: [
      [{ text: BTN.discover }, { text: BTN.promos }],
      [{ text: BTN.contact }, { text: BTN.history }],
      [{ text: BTN.home }],
    ],
    resize_keyboard: true,
  };
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
    keyboard.push([{ text: `➤ ${cat}`, callback_data: "noop" }]); // heading row
    const items = groups.get(cat);
    for (let i = 0; i < items.length; i += 2) {
      const row = items.slice(i, i + 2).map((p) => ({
        text: p.icon ? `${p.icon} ${p.name}` : p.name,
        callback_data: `name:${p.id}`,
      }));
      keyboard.push(row);
    }
  }

  await bot.sendMessage(chatId, "🛒 Going Forward Digital Shop\n\nကုန်ပစ္စည်း ရွေးချယ်ပါ 👇", {
    reply_markup: { inline_keyboard: keyboard },
  });
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
  await bot.sendMessage(chatId, `${anchor.name}\n\nMonth / Package ရွေးချယ်ပါ 👇`, {
    reply_markup: { inline_keyboard: keyboard },
  });
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

  let text = `<b>${esc(product.name)}</b>`;
  if (product.variant) text += `\n🏷 ${esc(product.variant)}`;
  let priceText = priceLine(product);
  if (product.duration) priceText += ` · ⏳ ${esc(product.duration)}`;
  text += `\n${priceText}`;
  if (product.description) text += `\n\n${esc(product.description)}`;

  const keyboard = [];
  let buyable = true;
  let soldOut = false;

  if (product.type === "auto") {
    const stock = await countAvailableStock(product.id);
    if (stock > 0) {
      text += `\n\n📦 လက်ကျန် - ${stock} ခု`;
    } else {
      // Out of stock: show the Burmese notice + a "buy from admin directly" button.
      text += `\n\nBot မှာ stock out ဖြစ်နေပါသည်.. Admin မှ တဆင့် ဝယ်ယူပေးပါ`;
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
    const variant = o.variant ? ` (${o.variant})` : "";
    return `🧾 <b>${esc(o.orderId)}</b> · ${esc(o.dateCreated)}\n   ${esc(o.productName)}${esc(variant)} — ${esc(o.price)} MMK\n   အခြေအနေ: ${esc(status)}`;
  });
  await bot.sendMessage(chatId, `📜 <b>သင့်ရဲ့ Order မှတ်တမ်း</b>\n\n${lines.join("\n\n")}`, {
    parse_mode: "HTML",
  });
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

/** Built as HTML. The account number and urgent phone are wrapped in <code> so
 *  Telegram renders them tap-to-copy (monospace = one-tap copy in the app). */
function buildPaymentInstructions(s, orderId, product, charged) {
  return [
    `🧾 Order ${esc(orderId)}`,
    `📦 ${esc(product.name)} (${esc(product.variant)})`,
    `💰 ဈေးနှုန်း: ${esc(charged)} MMK`,
    ``,
    `အောက်ပါအတိုင်း ငွေလွှဲပေးပါ 👇`,
    `💳 ငွေလွှဲနည်း: ${esc(s["Accepted Payment Methods"] || "-")}`,
    `🔢 အကောင့်နံပါတ်: <code>${esc(s["Bank Account Number"] || "-")}</code>`,
    `👤 အကောင့်အမည်: ${esc(s["Bank Account Name"] || "-")}`,
    `📝 ${esc(s["Payment Note Instruction"] || "")}`,
    ``,
    `☎️ အရေးပေါ်: <code>${esc(s["Urgent Contact Phone"] || "")}</code>`,
  ].join("\n");
}

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

async function handleCancel(query, pendingId) {
  const chatId = query.message.chat.id;
  pendingOrders.delete(pendingId); // never recorded to the sheet
  if (awaitingPayslip.get(chatId) === pendingId) awaitingPayslip.delete(chatId);
  await bot.sendMessage(chatId, "သင့် order ကို ပယ်ဖျက်လိုက်ပါပြီ။");
  await sendMainMenu(chatId);
}

// ─── Admin decisions ─────────────────────────────────────────────────────────

/** Append a status line to the admin's payslip message and remove its buttons so
 *  it can't be tapped twice. */
async function closeAdminMessage(query, statusLabel) {
  try {
    const original = query.message.caption || "";
    await bot.editMessageCaption(`${original}\n\n${statusLabel}`, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (e) {
    console.error("closeAdminMessage:", e.message);
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

    const stamp = now();
    const orderId = await createOrder({
      ...base,
      paymentStatus: "Paid",
      payslipSent: "Yes",
      adminDecision: "Verified",
      decisionTime: stamp,
      deliveryStatus: "Delivered",
      inventoryIdUsed: inv.inventoryId,
      credentialsSent: inv.credentials,
      usedDateTime: stamp,
    });

    // Polished delivery card + per-product tips (Name|Variant → Name → Type).
    const tips = product ? await resolveTips(product) : "";
    const card = [
      `✅ <b>Order အောင်မြင်ပါပြီ!</b>`,
      ``,
      `📦 ${esc(base.productName)}${base.variant ? ` — ${esc(base.variant)}` : ""}`,
      `🧾 Order ID: ${esc(orderId)}`,
      `💰 ဈေးနှုန်း: ${esc(base.price)} MMK`,
      ``,
      `🔐 သင့်အကောင့် အချက်အလက်များ:`,
      esc(inv.credentials),
    ];
    if (tips) card.push(``, `💡 <b>အကြံပြုချက်:</b>`, esc(tips));
    card.push(``, `🙏 ဝယ်ယူအားပေးမှုအတွက် ကျေးဇူးတင်ပါတယ်!`);
    await bot.sendMessage(base.customerChatId, card.join("\n"), { parse_mode: "HTML" });

    await markInventorySold(inv.rowNumber, { soldTo: base.customerUsername, orderId });

    // Restock reminder: if that was the last available unit, ping the admin.
    const remaining = await countAvailableStock(pending.productId);
    if (remaining <= 0) {
      await bot.sendMessage(
        adminId,
        `⚠️ <b>OUT OF STOCK</b>\n${esc(base.productName)}` +
          `${base.variant ? ` (${esc(base.variant)})` : ""} just sold its last unit. ` +
          `Please refill the Inventory sheet.`,
        { parse_mode: "HTML" }
      );
    }
  } else {
    pendingOrders.delete(pending.pendingId); // claim it
    const decTime = now();
    const orderId = await createOrder({
      ...base,
      paymentStatus: "Paid",
      payslipSent: "Yes",
      adminDecision: "Verified",
      decisionTime: decTime,
      deliveryStatus: "Awaiting Admin Contact",
    });
    const order = { ...base, orderId };

    // Canva has its own guided activation flow (email → invite → OK → expiry).
    if (isCanva(product)) {
      await closeAdminMessage(query, "✅ Verified");
      return startCanvaFlow(order);
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
      `👤 Customer: ${esc(order.customerUsername)}`,
      `🕒 Verified: ${esc(decTime)}`,
    ]
      .filter(Boolean)
      .join("\n");
    await bot.sendMessage(adminId, adminCard, { parse_mode: "HTML" });

    // Customer button opens the admin chat directly (URL button, no bot ping).
    const s = await getSettings();
    const adminUser = (s["Admin Telegram Username"] || "").replace(/^@/, "");
    const customerMsg =
      `✅ ${order.productName} (${order.variant}) အတွက် ငွေလက်ခံရရှိပါပြီ!\n\n` +
      `Activation ဆက်လုပ်ရန် အောက်က Admin ကို ဆက်သွယ်ပေးပါ 👇`;
    if (adminUser) {
      await bot.sendMessage(order.customerChatId, customerMsg, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📩 Admin ကို ဆက်သွယ်မယ်", url: `https://t.me/${adminUser}` }],
          ],
        },
      });
    } else {
      await bot.sendMessage(
        order.customerChatId,
        `${customerMsg}\n📞 ဖုန်း: ${s["Admin Contact Phone"] || "-"}`
      );
    }
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
  "ငွေလက်ခံရရှိပါသည် Canva အကောင့်လုပ်ထားတဲ့ ကိုယ့်ရဲ့mail ပို့ပေးရမှာပါရှင် (password မလိုပါရှင်) \n" +
  "🩵🩵မှတ်ချက် 🩵🩵\n" +
  "Email မပို့ခင် spelling/ အကြီးအသေး မမှားအောင် စာရိုက်ပြီး သေချာလေး စစ်ပြီးပို့ပေးပါနော်🙏🏻🙏🏻🙏🏻";

const CANVA_MSG_C =
  "ပို့ထားတဲ့ gmail ရဲ့ inbox လေးစစ်ပေးပါရှင်😇 Invite ပို့ထားပါတယ် Join Team နှိပ်ပေးပါ\n" +
  "(သတိပြုရန်💕💕💕)\n" +
  "👉🏻ဖုန်းနဲ့သုံးနေတာပဲဖြစ်ဖြစ် … \n" +
  "Computer နဲ့သုံးနေတာပဲဖြစ်ဖြစ် …\n" +
  "👉🏻Canva application မှာဝင်ထားတဲ့ အကောင့်ဟာ invite လုပ်ထားတဲ့ gmail နဲ့ဝင်ထားတာ ဖြစ်ရပါမယ်နော် 🥰 (same gmail ဖြစ်ရပါမယ်) \n" +
  "ပြီးရင် OK button နှိပ်ပေးပါ instructions ဆက်ပြောပေးပါလိမ့်မယ်";

const CANVA_MSG_D =
  "https://t.me/goingforward_premium/115\n" +
  "အပေါ်က link လေးကို နှိပ်ပြီး join နည်း instruction တွေ share ပေးထားပါတယ် Join ကြည့်ပါ\n" +
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
        `👤 Customer: ${esc(order.customerUsername)}\n` +
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

// ─── Callback queries (all button taps; callback_data is ID-based) ───────────

bot.on("callback_query", async (query) => {
  await bot.answerCallbackQuery(query.id);
  const chatId = query.message.chat.id;
  const data = query.data || "";
  const sep = data.indexOf(":");
  const action = sep === -1 ? data : data.slice(0, sep);
  const arg = sep === -1 ? "" : data.slice(sep + 1);

  try {
    switch (action) {
      case "menu":
        return sendMainMenu(chatId);
      case "name":
        return sendNameLevel(chatId, arg);
      case "detail":
        return sendDetailCard(chatId, arg);
      case "faq":
        return handleFaq(chatId, arg);
      case "buy":
        return handleBuy(query, arg);
      case "cancel":
        return handleCancel(query, arg);
      case "verify":
      case "noverify": {
        const adminId = await resolveAdminChatId();
        if (!adminId || String(chatId) !== String(adminId)) return; // admin only
        const pending = pendingOrders.get(arg);
        if (!pending) {
          return bot.sendMessage(chatId, "ℹ️ This order was already handled or cancelled.");
        }
        return action === "verify" ? handleVerify(query, pending) : handleNoVerify(query, pending);
      }
      case "contact":
        return handleContact(chatId);
      case "canva_send":
        return handleCanvaSend(query, arg);
      case "canva_added":
        return handleCanvaAdded(query, arg);
      case "canva_ok":
        return handleCanvaOk(query, arg);
      case "noop":
        return; // category heading — not clickable
      default:
        return;
    }
  } catch (err) {
    console.error(`Error handling callback "${data}":`, err.message);
    bot.sendMessage(chatId, "⚠️ တစ်ခုခု မှားယွင်းသွားပါတယ်။ ထပ်မံကြိုးစားပေးပါ။");
  }
});

// ─── Payslip photos ──────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const pendingId = awaitingPayslip.get(chatId);
  if (!pendingId) return; // not in the payslip flow — ignore

  const pending = pendingOrders.get(pendingId);
  if (!pending || pending.payslipReceived) {
    awaitingPayslip.delete(chatId);
    return;
  }

  try {
    pending.payslipReceived = true; // forward once
    awaitingPayslip.delete(chatId);

    const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    const s = await getSettings();
    const adminId = await resolveAdminChatId(s);
    const caption = [
      `🧾 New payslip`,
      `Order: ${pending.orderId}`,
      `Product: ${pending.productName} (${pending.variant})`,
      `Price: ${pending.price} MMK`,
      `Customer: ${pending.customerUsername}`,
    ].join("\n");

    if (adminId) {
      await bot.sendPhoto(adminId, fileId, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Verified", callback_data: `verify:${pending.orderId}` },
              { text: "❌ No Verify", callback_data: `noverify:${pending.orderId}` },
            ],
          ],
        },
      });
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

// Load the read-mostly tabs once at boot. Without this, whoever taps first
// after a restart waits on three or four cold Sheets calls.
warmCache().then(() => console.log("📦 Sheet cache warmed"));

console.log("🤖 Bot is running...");
