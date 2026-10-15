/**
 * Staff slip-check bot — a SEPARATE Telegram bot (its own token) that staff use
 * to check payment slips, so the admin doesn't have to look at every one.
 *
 *   staff sends a slip photo (caption = amount, e.g. 95000)
 *     → checkSlip() from slipcheck.js (the same engine the shop bot uses)
 *     → a coloured verdict comes back, with ✅ / ❌ buttons for the approvers.
 *
 * Three kinds of people (Telegram numeric IDs, or @usernames):
 *   STAFF_ALLOWED    can send slips.
 *   STAFF_APPROVERS  can press ✅ / ❌ under a verdict, but cannot send slips.
 *   ADMIN_CHAT_ID    always both.
 * Someone in both lists can do both.
 *
 * Pressing ✅ / ❌ only records the decision as a reply in the chat (who, when).
 * It does not touch the shop bot or the Order Desk: the bot can't see the bank,
 * so the approver checks the Bank/Wave app first. Red verdicts need a second,
 * confirming tap, like in the shop bot.
 *
 * Works in a private chat or in a group/supergroup (add the bot, disable privacy
 * mode in BotFather). Buttons appear in groups (where approvers can see them) and
 * in a private chat with someone who is an approver. In a group the bot stays
 * silent for people it doesn't serve and for ordinary chat.
 *
 * /order — the full order flow. Staff tap Source → payment method → customer →
 * product(s) → duration/plan → amount (list price or typed), up to 10 products
 * for ONE payment, then send the slip once. The slip is checked against the
 * basket total (a mismatch is a warning the approver sees, never a hard stop);
 * when an approver presses ✅ the order lands in the Order Desk, one row per
 * product, so nobody retypes it. ❌ writes nothing. Drafts live in memory (a
 * restart or ~3 hours without activity drops them; staff just start again).
 *
 * Duplicate detection uses the same Slips sheet as the shop bot (via
 * slipcheck.js → sheets.js), so a slip already used in either place is caught.
 *
 * Env: STAFF_BOT_TOKEN (required), STAFF_ALLOWED, STAFF_APPROVERS,
 *      ADMIN_CHAT_ID (optional), plus the usual SLIP_* and Google settings.
 *      Run with:  npm run start:staff
 */
import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { checkSlip, slipCheckEnabled } from "./slipcheck.js";
import { getSettings } from "./sheets.js";
import { deskEnabled, pushBasketToDesk } from "./desk.js";
import { loadCatalog } from "./desk-catalog.js";
import {
  newId, newDraft, basketText, basketTotal, render, applyAction, applyText, textStep, parseOrderCb,
  parseSellerNames, sellerFor, orderDecisionText, yangonNow, PROMPT, esc,
} from "./order-flow-lib.js";
import {
  parseStaffList, isStaff, isApprover, rolesOf, adminIdLooksWrong, parseCaptionAmount, formatVerdict,
  approvalRows, confirmRows, parseApproval, decisionText, MSG,
} from "./staff-bot-lib.js";

const token = process.env.STAFF_BOT_TOKEN;
if (!token) {
  console.error("Missing STAFF_BOT_TOKEN — create a bot with @BotFather and add its token.");
  process.exit(1);
}
if (token === process.env.TELEGRAM_BOT_TOKEN) {
  console.error("STAFF_BOT_TOKEN must be a different bot from TELEGRAM_BOT_TOKEN (two bots can't share one token).");
  process.exit(1);
}

const staff = parseStaffList(process.env.STAFF_ALLOWED || "");
const approvers = parseStaffList(process.env.STAFF_APPROVERS || "");
const adminId = process.env.ADMIN_CHAT_ID || "";
if (!staff.ids.size && !staff.names.size && !adminId) {
  console.warn("STAFF_ALLOWED and ADMIN_CHAT_ID are both empty — nobody can send slips yet.");
}
if (!approvers.ids.size && !approvers.names.size && !adminId) {
  console.warn("STAFF_APPROVERS and ADMIN_CHAT_ID are both empty — nobody can press ✅ / ❌ yet.");
}

if (adminIdLooksWrong(adminId)) {
  console.warn(
    "ADMIN_CHAT_ID contains more than one ID. It must be ONE number (your own Telegram ID) — " +
      "with a list it matches nobody, so not even you are treated as admin. " +
      "Put the others in STAFF_ALLOWED / STAFF_APPROVERS instead."
  );
}

const sellerNames = parseSellerNames(process.env.STAFF_SELLER_NAMES || "");

const bot = new TelegramBot(token, { polling: true });
bot.on("polling_error", (err) => console.error("Staff bot polling error (will keep retrying):", err.message));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));

const HTML = { parse_mode: "HTML", disable_web_page_preview: true };
const isGroup = (msg) => msg.chat.type === "group" || msg.chat.type === "supergroup";
const canSend = (from) => isStaff(from, staff, adminId);
const canApprove = (from) => isApprover(from, approvers, adminId);
const nameOf = (u) => (u?.username ? `@${u.username}` : [u?.first_name, u?.last_name].filter(Boolean).join(" ") || String(u?.id));
const myanmarTime = () =>
  new Date().toLocaleString("en-GB", { timeZone: "Asia/Yangon", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** Same rule as the shop bot (index.js): the admin's /rate setting, else SLIP_THB_MMK_RATE. */
async function thbRate() {
  try {
    const n = Number(String((await getSettings())["THB MMK Rate"] || "").replace(/,/g, ""));
    if (n > 0) return n;
  } catch {}
  return Number(process.env.SLIP_THB_MMK_RATE) || 0;
}

/** The slip image in a message: a normal photo, or an image sent "as file". */
function slipFile(msg) {
  if (msg.photo?.length) return { fileId: msg.photo[msg.photo.length - 1].file_id, mediaType: "image/jpeg" };
  const d = msg.document;
  if (d && /^image\/(jpeg|png|webp|gif)$/.test(d.mime_type || "")) return { fileId: d.file_id, mediaType: d.mime_type };
  return null;
}


// ─── /order: drafts held in memory ───────────────────────────────────────────
const DRAFT_TTL_MS = 3 * 60 * 60 * 1000;
const drafts = new Map(); // id → draft
const approvalDraft = new Map(); // "chatId:messageId" of a verdict → draft id
setInterval(() => {
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const [id, d] of drafts) if ((d.touchedAt || d.createdAt) < cutoff) drafts.delete(id);
  for (const [k, id] of approvalDraft) if (!drafts.has(id)) approvalDraft.delete(k);
}, 10 * 60 * 1000).unref();

const touch = (d) => ({ ...d, touchedAt: Date.now() });
const openDraftOf = (from, chatId) =>
  [...drafts.values()].reverse().find((d) => d.status === "open" && d.ownerId === String(from.id) && d.chatId === chatId);
const displayName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username || String(u?.id);

/** Show (or refresh) the draft's panel: edit its message, or send a new one if that fails. */
async function showPanel(draft, catalog) {
  const { text, rows } = render(draft, catalog);
  const opts = { ...HTML, reply_markup: { inline_keyboard: rows } };
  if (draft.msgId) {
    try {
      await bot.editMessageText(text, { chat_id: draft.chatId, message_id: draft.msgId, ...opts });
      return;
    } catch (e) {
      if (/not modified/i.test(e.message)) return;
      // fall through: the old panel can't be edited any more, so send a fresh one
    }
  }
  const sent = await bot.sendMessage(draft.chatId, text, opts);
  draft.msgId = sent.message_id;
  const cur = drafts.get(draft.id);
  if (cur) cur.msgId = sent.message_id;
}

async function startOrder(msg) {
  const chatId = msg.chat.id;
  try {
    if (!deskEnabled()) return bot.sendMessage(chatId, "Order Desk မချိတ်ရသေးပါ (DESK_SHEET_ID) — Admin ကို ပြောပါ။");
    if (!slipCheckEnabled()) return bot.sendMessage(chatId, MSG.disabled);
    let catalog;
    try {
      catalog = await loadCatalog();
    } catch (e) {
      console.warn("catalog load failed:", e.message);
      // Show the reason too (short, no secrets) so it can be fixed without digging through logs.
      return bot.sendMessage(chatId, `${PROMPT.noCatalog}\n\n(${String(e.message).slice(0, 200)})`);
    }
    const old = openDraftOf(msg.from, chatId);
    if (old) {
      old.status = "cancelled";
      drafts.delete(old.id);
      if (old.msgId) bot.editMessageText(PROMPT.cancelled, { chat_id: chatId, message_id: old.msgId }).catch(() => {});
    }
    let id = newId();
    while (drafts.has(id)) id = newId();
    const draft = touch({ ...newDraft({ id, ownerId: msg.from.id, ownerName: displayName(msg.from), chatId }), msgId: null });
    drafts.set(id, draft);
    await showPanel(draft, catalog);
  } catch (e) {
    console.error("startOrder:", e.message);
    bot.sendMessage(chatId, MSG.failed).catch(() => {});
  }
}

bot.onText(/^\/order\b/, async (msg) => {
  if (!isGroup(msg) && msg.chat.type !== "private") return;
  if (!canSend(msg.from)) {
    if (isGroup(msg)) return;
    return bot.sendMessage(msg.chat.id, canApprove(msg.from) ? MSG.approverOnly : MSG.notAllowed(msg.from?.id), HTML);
  }
  return startOrder(msg);
});

bot.onText(/^\/cancel\b/, async (msg) => {
  if (!isGroup(msg) && msg.chat.type !== "private") return;
  if (!canSend(msg.from)) return;
  const d = openDraftOf(msg.from, msg.chat.id);
  if (!d) return bot.sendMessage(msg.chat.id, PROMPT.needOrderFirst);
  d.status = "cancelled";
  drafts.delete(d.id);
  if (d.msgId) bot.editMessageText(PROMPT.cancelled, { chat_id: d.chatId, message_id: d.msgId }).catch(() => {});
  return bot.sendMessage(msg.chat.id, PROMPT.cancelled);
});

/** Typed text for the current text step (customer / amount / email). */
async function handleOrderText(msg, draft) {
  if (!textStep(draft)) {
    if (!isGroup(msg)) await bot.sendMessage(msg.chat.id, "👆 ခလုတ်တွေကို နှိပ်ပါ။ (မလုပ်တော့ရင် /cancel)");
    return;
  }
  const res = applyText(draft, msg.text);
  if (res.toast) return bot.sendMessage(msg.chat.id, res.toast, { ...HTML, reply_to_message_id: msg.message_id });
  const next = touch({ ...res.draft, msgId: draft.msgId });
  drafts.set(next.id, next);
  await showPanel(next, await loadCatalog());
}

/** The slip for a draft: checked ONCE against the basket total. */
async function handleOrderSlip(msg, draft, file) {
  if (draft.step !== "slip") return bot.sendMessage(msg.chat.id, PROMPT.slipTooEarly, { ...HTML, reply_to_message_id: msg.message_id });
  if (draft.checking) return bot.sendMessage(msg.chat.id, PROMPT.checkingBusy, { reply_to_message_id: msg.message_id });
  if (!slipCheckEnabled()) return bot.sendMessage(msg.chat.id, MSG.disabled);

  const live = drafts.get(draft.id);
  live.checking = true;
  const status = await bot.sendMessage(msg.chat.id, MSG.checking, { reply_to_message_id: msg.message_id });
  bot.sendChatAction(msg.chat.id, "typing").catch(() => {});
  let text;
  let level = null;
  try {
    const res = await fetch(await bot.getFileLink(file.fileId));
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const result = await checkSlip({
      imageBuffer: Buffer.from(await res.arrayBuffer()),
      mediaType: file.mediaType,
      expectedAmount: basketTotal(draft),
      // Same ref every time for one basket: re-sending a better photo isn't "a duplicate".
      ref: `staff:${draft.ref}`,
      customer: draft.customer,
      thbRate: await thbRate(),
    });
    text = formatVerdict(result, { hasAmount: true });
    level = result?.level ?? null;
  } catch (e) {
    console.warn("order slip check failed:", e.message);
    text = MSG.failed;
  } finally {
    live.checking = false;
    live.touchedAt = Date.now();
  }
  bot.deleteMessage(msg.chat.id, status.message_id).catch(() => {});

  const body = `${basketText(draft)}\n\n${text}`;
  if (!level) return bot.sendMessage(msg.chat.id, body, { ...HTML, reply_to_message_id: msg.message_id });

  const buttons = { reply_markup: { inline_keyboard: approvalRows(level) } };
  if (isGroup(msg) || canApprove(msg.from)) {
    const sent = await bot.sendMessage(msg.chat.id, body, { ...HTML, reply_to_message_id: msg.message_id, ...buttons });
    approvalDraft.set(`${sent.chat.id}:${sent.message_id}`, draft.id);
    return;
  }
  // Private chat with someone who can't press ✅/❌: send the verdict to the approvers.
  const targets = [...new Set([...approvers.ids, adminId].filter((x) => /^-?\d+$/.test(String(x))))];
  let sentTo = 0;
  for (const t of targets) {
    try {
      const sent = await bot.sendMessage(t, `${body}\n\n👤 ${esc(draft.ownerName)}`, { ...HTML, ...buttons });
      approvalDraft.set(`${sent.chat.id}:${sent.message_id}`, draft.id);
      sentTo++;
    } catch (e) {
      console.warn(`could not send the verdict to approver ${t}: ${e.message}`);
    }
  }
  await bot.sendMessage(msg.chat.id, `${body}\n\n${sentTo ? PROMPT.sentToApprovers : PROMPT.noApprovers}`, {
    ...HTML,
    reply_to_message_id: msg.message_id,
  });
}

/** A button on an order panel. */
async function handleOrderCallback(q, oc) {
  const answer = (text, alert = false) => bot.answerCallbackQuery(q.id, text ? { text, show_alert: alert } : {}).catch(() => {});
  if (!q.message) return answer();
  const target = { chat_id: q.message.chat.id, message_id: q.message.message_id };
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch {
    return answer(PROMPT.noCatalog, true);
  }
  const draft = drafts.get(oc.id); // read AFTER the await: two quick taps then act one after the other
  if (!draft || draft.status !== "open") {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, target).catch(() => {});
    return answer(PROMPT.expired, true);
  }
  if (String(q.from.id) !== draft.ownerId) return answer(PROMPT.notYours, true);

  const res = applyAction(draft, oc, catalog);
  if (res.cancel) {
    draft.status = "cancelled";
    drafts.delete(draft.id);
    await bot.editMessageText(PROMPT.cancelled, target).catch(() => {});
    return answer();
  }
  if (res.toast) return answer(res.toast, true);
  const next = touch({ ...res.draft, msgId: draft.msgId });
  drafts.set(next.id, next);
  await showPanel(next, catalog);
  return answer();
}

/** An approver's ✅ / ❌ on a verdict that belongs to an order. Returns true when it handled the tap. */
async function decideOrder({ q, p, key, draftId, answer }) {
  const draft = drafts.get(draftId);
  if (!draft || draft.status !== "open") {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    answer(PROMPT.expired, true);
    return null;
  }
  const who = nameOf(q.from);
  if (p.action === "no") return { text: orderDecisionText("no", draft, null, who), draft, desk: null };

  // ✅ — claim the draft first, so two approvers tapping together can't both write it.
  draft.status = "writing";
  const dateTime = yangonNow();
  const desk = await pushBasketToDesk({ draft, seller: sellerFor(draft, null, sellerNames), dateTime });
  if (!desk.ok) {
    draft.status = "open";
    console.error(`order ${draft.ref}: Desk write failed: ${desk.error || desk.skipped}`);
    answer(`Order Desk ထဲ မရေးနိုင်ပါ — ပြန်နှိပ်ကြည့်ပါ။\n(${desk.error || desk.skipped})`, true);
    return null;
  }
  draft.status = "done";
  drafts.delete(draft.id);
  console.log(`order ${draft.ref}: ${draft.lines.length} row(s) written to the Desk (No. ${desk.nos.join(",")}), approved by ${who}`);
  return { text: orderDecisionText("ok", draft, desk, who), draft, desk };
}

// /myid works for anyone, anywhere: it shows your Telegram ID and what you may do here,
// so IDs can be copied into STAFF_ALLOWED / STAFF_APPROVERS without guessing.
bot.onText(/^\/myid\b/, async (msg) => {
  if (!isGroup(msg) && msg.chat.type !== "private") return;
  const roles = rolesOf(msg.from, staff, approvers, adminId);
  bot.sendMessage(msg.chat.id, MSG.myId(msg.from.id, msg.from.username, roles), { ...HTML, reply_to_message_id: msg.message_id });
});

bot.onText(/^\/(start|help)\b/, async (msg) => {
  if (!isGroup(msg) && msg.chat.type !== "private") return;
  const group = isGroup(msg);
  if (canSend(msg.from)) return bot.sendMessage(msg.chat.id, MSG.welcome, HTML);
  if (canApprove(msg.from)) return bot.sendMessage(msg.chat.id, MSG.approverOnly, HTML);
  if (!group) await bot.sendMessage(msg.chat.id, MSG.notAllowed(msg.from?.id), HTML);
});

bot.on("message", async (msg) => {
  try {
    if (msg.text?.startsWith("/")) return; // commands handled above
    const group = isGroup(msg);
    if (!group && msg.chat.type !== "private") return;

    if (!canSend(msg.from)) {
      // In a group, stay quiet for anyone who can't send slips.
      if (group) return;
      const photo = slipFile(msg);
      if (canApprove(msg.from)) return photo ? bot.sendMessage(msg.chat.id, MSG.approverOnly, HTML) : undefined;
      return bot.sendMessage(msg.chat.id, MSG.notAllowed(msg.from?.id), HTML);
    }

    // Someone in the middle of an /order: their text and their slip belong to it.
    const draft = openDraftOf(msg.from, msg.chat.id);
    if (draft) {
      if (msg.text) return handleOrderText(msg, draft);
      const f = slipFile(msg);
      if (f) return handleOrderSlip(msg, draft, f);
    }

    const file = slipFile(msg);
    if (!file) {
      // Ordinary chat in a group is none of the bot's business.
      if (!group) await bot.sendMessage(msg.chat.id, MSG.needImage);
      return;
    }
    if (!slipCheckEnabled()) return bot.sendMessage(msg.chat.id, MSG.disabled);

    const { amount, ambiguous } = parseCaptionAmount(msg.caption);
    if (ambiguous) return bot.sendMessage(msg.chat.id, MSG.ambiguousAmount, HTML);

    const status = await bot.sendMessage(msg.chat.id, MSG.checking, { reply_to_message_id: msg.message_id });
    bot.sendChatAction(msg.chat.id, "typing").catch(() => {});

    let text;
    let buttons = null;
    try {
      const res = await fetch(await bot.getFileLink(file.fileId));
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const imageBuffer = Buffer.from(await res.arrayBuffer());
      const result = await checkSlip({
        imageBuffer,
        mediaType: file.mediaType,
        expectedAmount: amount,
        // A unique ref per message: re-sending the same slip shows up as a duplicate.
        ref: `staff:${msg.chat.id}:${msg.message_id}`,
        customer: `staff ${nameOf(msg.from)}`,
        thbRate: await thbRate(),
      });
      text = formatVerdict(result, { hasAmount: amount != null });
      // Buttons only where an approver can actually press them.
      if (result && (group || canApprove(msg.from))) buttons = approvalRows(result.level);
    } catch (e) {
      console.warn("staff slip check failed:", e.message);
      text = MSG.failed;
    }

    await bot.sendMessage(msg.chat.id, text, {
      ...HTML,
      reply_to_message_id: msg.message_id,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    bot.deleteMessage(msg.chat.id, status.message_id).catch(() => {});
  } catch (e) {
    console.error("staff bot handler:", e.message);
  }
});

// Verdicts already decided (message key), so two quick taps can't both count.
const decided = new Set();

bot.on("callback_query", async (q) => {
  const answer = (text, alert = false) => bot.answerCallbackQuery(q.id, text ? { text, show_alert: alert } : {}).catch(() => {});
  try {
    const oc = parseOrderCb(q.data);
    if (oc) return await handleOrderCallback(q, oc);

    const p = parseApproval(q.data);
    if (!p || !q.message) return answer();
    if (!canApprove(q.from)) {
      console.log(`approve refused: user ${q.from.id} is not an approver (add the ID to STAFF_APPROVERS)`);
      return answer(`${MSG.notApprover}\n(သင့် ID: ${q.from.id})`, true);
    }

    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;
    const key = `${chatId}:${messageId}`;
    if (decided.has(key)) return answer(MSG.alreadyDecided, true);
    const target = { chat_id: chatId, message_id: messageId };

    if (p.action === "ask") {
      await bot.editMessageReplyMarkup({ inline_keyboard: confirmRows(p.level) }, target).catch(() => {});
      return answer(MSG.askSure, true);
    }
    if (p.action === "back") {
      await bot.editMessageReplyMarkup({ inline_keyboard: approvalRows(p.level) }, target).catch(() => {});
      return answer();
    }

    // ok / no — final. Claim the message first so a second tap is refused.
    decided.add(key);
    try {
      // A verdict that belongs to an /order: ✅ writes the Desk rows first (nothing is
      // announced unless that worked), ❌ writes nothing.
      const draftId = approvalDraft.get(key);
      let order = null;
      if (draftId) {
        order = await decideOrder({ q, p, key, draftId, answer });
        if (!order) {
          decided.delete(key);
          return; // already answered (expired, or the Desk write failed → buttons stay)
        }
      }
      await bot.sendMessage(chatId, decisionText(p.action, p.level, nameOf(q.from), myanmarTime()) + (order ? `\n${order.text}` : ""), {
        ...HTML,
        reply_to_message_id: messageId,
      });
      // The staff member may be in a different chat (private) from the approver.
      if (order && order.draft.chatId !== chatId) {
        bot.sendMessage(order.draft.chatId, order.text, HTML).catch((e) => console.warn("could not tell the staff member:", e.message));
      }
    } catch (e) {
      decided.delete(key); // nothing was recorded, so let them try again
      throw e;
    }
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, target).catch(() => {});
    console.log(`slip ${p.action === "ok" ? "approved" : "rejected"} by ${nameOf(q.from)} (${key}, verdict ${p.level})`);
    return answer();
  } catch (e) {
    console.error("staff bot callback:", e.message);
    return answer("မအောင်မြင်ပါ — ပြန်နှိပ်ကြည့်ပါ", true);
  }
});

console.log(
  `Staff slip-check bot running (senders: ${staff.ids.size} ID, ${staff.names.size} username; ` +
    `approvers: ${approvers.ids.size} ID, ${approvers.names.size} username${adminId ? "; admin is both" : ""}).`
);
