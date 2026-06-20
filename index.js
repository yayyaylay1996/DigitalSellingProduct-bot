import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import {
  now,
  getSettings,
  setSetting,
  getProducts,
  getProductById,
  countAvailableStock,
  getAvailableInventory,
  markInventorySold,
  createOrder,
  getOrderByOrderId,
  updateOrderByOrderId,
} from "./sheets.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Customers who have an order in "Awaiting Payslip" status and whose next photo
// should be treated as a payment slip.  Map<chatId, orderId> — same in-memory
// state pattern the old email flow used.
const awaitingPayslip = new Map();

// The admin's numeric chat id. Telegram bots can only message a user by chat id,
// not by @username, so we resolve it from Settings ("Admin Chat ID") or capture
// it when the admin /starts the bot, then persist it back to the sheet.
let adminChatId = null;

async function resolveAdminChatId(settings) {
  if (adminChatId) return adminChatId;
  const s = settings || (await getSettings());
  if (s["Admin Chat ID"]) {
    adminChatId = s["Admin Chat ID"];
    return adminChatId;
  }
  if (process.env.ADMIN_CHAT_ID) {
    adminChatId = process.env.ADMIN_CHAT_ID;
    return adminChatId;
  }
  return null;
}

// ─── Menu rendering ──────────────────────────────────────────────────────────

/** Main menu: one button per unique Product Name. callback_data anchors on the
 *  first Product ID of each name group (never on the display name). */
async function sendMainMenu(chatId) {
  const products = await getProducts();
  if (products.length === 0) {
    return bot.sendMessage(chatId, "No products available right now. Check back later!");
  }
  const seen = new Set();
  const keyboard = [];
  for (const p of products) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    keyboard.push([{ text: p.name, callback_data: `name:${p.id}` }]);
  }
  await bot.sendMessage(chatId, "🛒 Going Forward Digital Shop\n\nChoose a product:", {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/** Given any Product ID in a name group, show the variant list — or jump
 *  straight to the detail card if the name has only one variant. */
async function sendNameLevel(chatId, anchorId) {
  const products = await getProducts();
  const anchor = products.find((p) => p.id === anchorId);
  if (!anchor) return bot.sendMessage(chatId, "❌ Product not found.");

  const group = products.filter((p) => p.name === anchor.name);
  if (group.length === 1) return sendDetailCard(chatId, group[0].id);

  const keyboard = group.map((p) => [
    { text: `${p.variant} — ${p.price} MMK`, callback_data: `detail:${p.id}` },
  ]);
  keyboard.push([{ text: "🏠 Main menu", callback_data: "menu" }]);
  await bot.sendMessage(chatId, `${anchor.name}\n\nChoose a variant:`, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/** Detail card for one Product ID. Shows live stock for ready products; email
 *  products show no stock number and always allow Buy now. */
async function sendDetailCard(chatId, productId) {
  const products = await getProducts();
  const product = products.find((p) => p.id === productId);
  if (!product) return bot.sendMessage(chatId, "❌ Product not found.");

  const group = products.filter((p) => p.name === product.name);
  const anchorId = group[0].id;
  const backData = group.length > 1 ? `name:${anchorId}` : "menu";

  let text = `${product.name}`;
  if (product.variant) text += `\n🏷 ${product.variant}`;
  text += `\n💰 ${product.price} MMK`;
  if (product.description) text += `\n\n${product.description}`;

  const keyboard = [];
  let buyable = true;

  if (product.type === "ready") {
    const stock = await countAvailableStock(product.id);
    if (stock > 0) {
      text += `\n\n📦 In stock: ${stock}`;
    } else {
      text += `\n\n❌ Sold Out`;
      buyable = false;
    }
  }
  // email products: no stock line, always buyable.

  if (buyable) {
    keyboard.push([{ text: "🛒 Buy now", callback_data: `buy:${product.id}` }]);
  }
  keyboard.push([
    { text: "⬅️ Back", callback_data: backData },
    { text: "🏠 Main menu", callback_data: "menu" },
  ]);

  await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ─── Buy flow ────────────────────────────────────────────────────────────────

function customerLabel(from) {
  return from.username ? `@${from.username}` : `${from.first_name || "User"} (id:${from.id})`;
}

function buildPaymentInstructions(s, orderId, product) {
  return [
    `🧾 Order ${orderId}`,
    `📦 ${product.name} (${product.variant})`,
    `💰 Price: ${product.price} MMK`,
    ``,
    `Please pay to:`,
    `💳 Methods: ${s["Accepted Payment Methods"] || "-"}`,
    `🔢 Account Number: ${s["Bank Account Number"] || "-"}`,
    `👤 Account Name: ${s["Bank Account Name"] || "-"}`,
    `📝 ${s["Payment Note Instruction"] || ""}`,
    ``,
    `After paying, send a photo of your payment slip in this chat.`,
    `⏱ ${s["Delivery Promise"] || ""}`,
    `☎️ Urgent: ${s["Urgent Contact Phone"] || ""}`,
  ].join("\n");
}

async function handleBuy(query, productId) {
  const chatId = query.message.chat.id;
  const product = await getProductById(productId);
  if (!product) return bot.sendMessage(chatId, "❌ Product not found.");

  if (product.type === "ready") {
    const stock = await countAvailableStock(product.id);
    if (stock <= 0) {
      return bot.sendMessage(chatId, `❌ Sorry, ${product.name} (${product.variant}) is sold out.`);
    }
  }

  const username = customerLabel(query.from);
  const orderId = await createOrder({
    customerUsername: username,
    customerChatId: chatId,
    productId: product.id,
    productName: product.name,
    variant: product.variant,
    price: product.price,
  });
  awaitingPayslip.set(chatId, orderId);

  const s = await getSettings();
  await bot.sendMessage(chatId, buildPaymentInstructions(s, orderId, product), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "❌ Cancel Buy", callback_data: `cancel:${orderId}` }],
        [{ text: "🏠 Main Menu", callback_data: "menu" }],
      ],
    },
  });
}

async function handleCancel(query, orderId) {
  const chatId = query.message.chat.id;
  await updateOrderByOrderId(orderId, { paymentStatus: "Cancelled" });
  if (awaitingPayslip.get(chatId) === orderId) awaitingPayslip.delete(chatId);
  await bot.sendMessage(chatId, "Your order has been cancelled.");
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

async function handleVerify(query, order) {
  const adminId = query.message.chat.id;
  const product = await getProductById(order.productId);
  const type = product ? product.type : "ready";

  if (type === "ready") {
    const inv = await getAvailableInventory(order.productId);
    if (!inv) {
      // Tell the admin and stop — leave buttons so they can retry after restocking.
      return bot.sendMessage(
        adminId,
        `⚠️ Sold out: no available inventory for ${order.orderId} ` +
          `(${order.productName} ${order.variant}). Add stock, then tap Verified again.`
      );
    }
    await updateOrderByOrderId(order.orderId, { adminDecision: "Verified", decisionTime: now() });
    await bot.sendMessage(
      order.customerChatId,
      `✅ Payment verified! Here are your account details for ` +
        `${order.productName} (${order.variant}):\n\n${inv.credentials}\n\nThank you for your purchase.`
    );
    await markInventorySold(inv.rowNumber, {
      soldTo: order.customerUsername,
      orderId: order.orderId,
    });
    await updateOrderByOrderId(order.orderId, {
      inventoryIdUsed: inv.inventoryId,
      credentialsSent: inv.credentials,
      usedDateTime: now(),
      deliveryStatus: "Delivered",
    });
  } else {
    await updateOrderByOrderId(order.orderId, { adminDecision: "Verified", decisionTime: now() });
    await bot.sendMessage(
      order.customerChatId,
      `✅ Payment verified for ${order.productName} (${order.variant})!\n\n` +
        `Tap below to contact the admin and continue your activation.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📩 Contact Admin to Continue", callback_data: `continue:${order.orderId}` }],
          ],
        },
      }
    );
    await updateOrderByOrderId(order.orderId, { deliveryStatus: "Awaiting Admin Contact" });
  }

  await closeAdminMessage(query, "✅ Verified");
}

async function handleNoVerify(query, order) {
  await updateOrderByOrderId(order.orderId, {
    adminDecision: "No Verify",
    decisionTime: now(),
    paymentStatus: "Not Verified",
  });
  await bot.sendMessage(
    order.customerChatId,
    `❌ Sorry, your payment for ${order.productName} (${order.variant}) could not be verified.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 Main", callback_data: "menu" }],
          [{ text: "📞 Contact Admin", callback_data: `contact:${order.orderId}` }],
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
    `Need help? Contact our admin:\n` +
      `📞 Phone: ${s["Admin Contact Phone"] || "-"}\n` +
      `💬 Telegram: ${s["Admin Telegram Username"] || "-"}`
  );
}

async function handleContinue(chatId, orderId) {
  const order = await getOrderByOrderId(orderId);
  if (!order) return bot.sendMessage(chatId, "❌ Order not found.");
  const s = await getSettings();
  const adminId = await resolveAdminChatId(s);
  if (adminId) {
    await bot.sendMessage(
      adminId,
      `📩 Customer ready to continue (email product):\n` +
        `Order: ${order.orderId}\n` +
        `Product: ${order.productName} (${order.variant})\n` +
        `Price: ${order.price} MMK\n` +
        `Customer: ${order.customerUsername} (chat id: ${order.customerChatId})`
    );
  } else {
    console.warn(`No admin chat id known; cannot notify admin for ${orderId}.`);
  }
  await bot.sendMessage(
    chatId,
    `Thanks! Our admin will reach out shortly. You can also contact them directly:\n` +
      `📞 Phone: ${s["Admin Contact Phone"] || "-"}\n` +
      `💬 Telegram: ${s["Admin Telegram Username"] || "-"}`
  );
}

// ─── /start and "Products" ───────────────────────────────────────────────────

/** If this user's @username matches the Settings Admin Telegram Username, record
 *  their chat id (in memory + persisted to the sheet) so the bot can message them. */
async function maybeCaptureAdmin(msg) {
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

async function handleStart(msg) {
  const chatId = msg.chat.id;
  try {
    const isAdmin = await maybeCaptureAdmin(msg);
    if (isAdmin) {
      await bot.sendMessage(chatId, "✅ Admin registered. You'll receive payslips here.");
    }
    await sendMainMenu(chatId);
  } catch (err) {
    console.error("Error in /start:", err.message);
    bot.sendMessage(chatId, "⚠️ Failed to load products. Please try again.");
  }
}

bot.onText(/^\/start\b/, handleStart);
bot.onText(/^\s*Products\s*$/i, (msg) => sendMainMenu(msg.chat.id));

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
      case "buy":
        return handleBuy(query, arg);
      case "cancel":
        return handleCancel(query, arg);
      case "verify":
      case "noverify": {
        const adminId = await resolveAdminChatId();
        if (!adminId || String(chatId) !== String(adminId)) return; // admin only
        const order = await getOrderByOrderId(arg);
        if (!order) return bot.sendMessage(chatId, "❌ Order not found.");
        if (order.adminDecision && order.adminDecision !== "Pending") {
          return bot.sendMessage(chatId, `This order was already marked "${order.adminDecision}".`);
        }
        return action === "verify" ? handleVerify(query, order) : handleNoVerify(query, order);
      }
      case "contact":
        return handleContact(chatId);
      case "continue":
        return handleContinue(chatId, arg);
      default:
        return;
    }
  } catch (err) {
    console.error(`Error handling callback "${data}":`, err.message);
    bot.sendMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
});

// ─── Payslip photos ──────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const orderId = awaitingPayslip.get(chatId);
  if (!orderId) return; // not in the payslip flow — ignore

  try {
    const order = await getOrderByOrderId(orderId);
    if (!order || order.paymentStatus !== "Awaiting Payslip") {
      awaitingPayslip.delete(chatId);
      return;
    }

    await updateOrderByOrderId(orderId, { payslipSent: "Yes", paymentStatus: "Payslip Received" });
    awaitingPayslip.delete(chatId);

    const fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    const s = await getSettings();
    const adminId = await resolveAdminChatId(s);
    const caption = [
      `🧾 New payslip`,
      `Order: ${order.orderId}`,
      `Product: ${order.productName} (${order.variant})`,
      `Price: ${order.price} MMK`,
      `Customer: ${order.customerUsername}`,
    ].join("\n");

    if (adminId) {
      await bot.sendPhoto(adminId, fileId, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Verified", callback_data: `verify:${order.orderId}` },
              { text: "❌ No Verify", callback_data: `noverify:${order.orderId}` },
            ],
          ],
        },
      });
    } else {
      console.warn(
        `No admin chat id known; cannot forward payslip for ${order.orderId}. ` +
          `Admin must send /start to the bot first.`
      );
    }

    await bot.sendMessage(chatId, "✅ Payment received, waiting for admin verification.");
  } catch (err) {
    console.error("payslip error:", err.message);
    bot.sendMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
});

console.log("🤖 Bot is running...");
