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
      await bot.sendMessage(chatId, decisionText(p.action, p.level, nameOf(q.from), myanmarTime()), {
        ...HTML,
        reply_to_message_id: messageId,
      });
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
