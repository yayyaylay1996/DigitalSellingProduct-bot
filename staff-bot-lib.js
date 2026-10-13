/**
 * Pure helpers for the staff slip-check bot (staff-bot.js): who may use it,
 * reading the amount from a photo caption, and the Burmese (Unicode) messages.
 * No network or Telegram access here, so everything is covered by `npm test`.
 */
import { burmeseToLatin } from "./slipcheck.js";

/** "123456, @some_staff 789" → numeric IDs and lower-cased usernames. Telegram
 *  IDs never change; usernames can, so prefer IDs for staff. */
export function parseStaffList(raw = "") {
  const ids = new Set();
  const names = new Set();
  for (const part of String(raw).split(/[,\s;]+/)) {
    const t = part.trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) ids.add(t);
    else names.add(t.replace(/^@/, "").toLowerCase());
  }
  return { ids, names };
}

/** The admin (ADMIN_CHAT_ID) is always allowed; everyone else must be listed. */
export function isStaff(from, list, adminId = "") {
  if (!from) return false;
  if (adminId && String(from.id) === String(adminId)) return true;
  if (list.ids.has(String(from.id))) return true;
  return Boolean(from.username && list.names.has(from.username.toLowerCase()));
}

/** Read the order amount from a photo caption: "95000", "95,000 ks", "၉၅,၀၀၀".
 *  Two different numbers in one caption are ambiguous, so we don't guess. */
export function parseCaptionAmount(text) {
  if (!text) return { amount: null, ambiguous: false };
  // Drop @mentions first: "@slip_bot2" must not count as the number 2.
  const t = burmeseToLatin(String(text)).replace(/@\w+/g, " ").replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  const found = [...new Set((t.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0))];
  if (found.length === 0) return { amount: null, ambiguous: false };
  if (found.length > 1) return { amount: null, ambiguous: true };
  return { amount: found[0], ambiguous: false };
}

export const MSG = {
  myId: (id, username, r) =>
    `သင့် Telegram ID: <code>${id}</code>${username ? `\nUsername: @${username}` : ""}\n\n` +
    `Slip ပို့ခွင့်: ${r.send ? "✅ ရှိတယ်" : "❌ မရှိဘူး"}\n` +
    `အတည်ပြုခွင့်: ${r.approve ? "✅ ရှိတယ်" : "❌ မရှိဘူး"}`,
  btnOk: "✅ ပိုက်ဆံဝင်ပြီ — အတည်ပြု",
  btnVerified: "✅ အတည်ပြု",
  btnNo: "❌ မအတည်ပြု",
  btnAnyway: "⚠️ ဒါပေမဲ့ အတည်ပြု…",
  btnConfirm: "⚠️ သေချာတယ် — အတည်ပြု",
  btnBack: "↩️ နောက်သို့",
  askSure: "🔴 ပြဿနာပြနေတဲ့ slip ပါ။ Bank/Wave app မှာ ပိုက်ဆံဝင်ကြောင်း သေချာမှ \"သေချာတယ်\" ကို နှိပ်ပါ။",
  notApprover: "အတည်ပြုခွင့် မရှိပါဘူး — အတည်ပြုသူတွေပဲ နှိပ်ခွင့်ရှိပါတယ်။",
  alreadyDecided: "ဒီ slip ကို ဆုံးဖြတ်ပြီးသားပါ။",
  approverOnly:
    "သင်က <b>အတည်ပြုသူ</b> ပါ — slip ပို့ခွင့် မရှိပါဘူး။ Staff ပို့တဲ့ slip ရဲ့ verdict အောက်က ✅ / ❌ ခလုတ်ကို နှိပ်ပါ။",
  welcome:
    "မင်္ဂလာပါ 👋\n\n🛒 Order အသစ်ထည့်ဖို့ <b>/order</b> လို့ ရိုက်ပါ (ခလုတ်တွေနဲ့ ရွေးပြီး slip တစ်ပုံတည်းနဲ့ product ၁၀ ခုအထိ ထည့်လို့ရပါတယ်)။\n\nSlip ကိုပဲ အမြန်စစ်ချင်ရင်တော့ slip ပုံကို ဒီမှာ ပို့ပါ။ ပုံနဲ့အတူ caption မှာ customer ပေးရမယ့် ပမာဏကို ရိုက်ထည့်ပါ (ဥပမာ <code>95000</code>)။\n\n• ပမာဏ မထည့်ရင် ပုံထဲက အချက်တွေကိုပဲ စစ်ပါမယ်\n• Wave ဖုန်းဓာတ်ပုံတွေဟာ ဖတ်လို့ မှားနိုင်လို့ <b>Wave app ထဲမှာ မျက်စိနဲ့ ထပ်စစ်ပါ</b>\n• ပုံကို file အဖြစ် (Send as File) ပို့ရင် ပိုရှင်းပါတယ်\n• Group ထဲမှာဆိုရင်လည်း ဒီအတိုင်း slip ပုံကို ပို့ရုံပါပဲ — သတ်မှတ်ထားတဲ့ staff တွေရဲ့ ပုံကိုပဲ စစ်ပေးပါမယ်",
  notAllowed: (id) =>
    `ဒီ bot ကို staff တွေပဲ သုံးခွင့်ရှိပါတယ်။\n\nသင့် Telegram ID: <code>${id}</code>\nAdmin ကို ဒီ ID ပေးပြီး ထည့်ခိုင်းပါ။`,
  checking: "🔍 Slip ကို စစ်နေပါတယ်... (စက္ကန့် ၂၀ လောက်ကြာနိုင်ပါတယ်)",
  needImage: "Slip ပုံကို ပို့ပါ (ဓာတ်ပုံ ဒါမှမဟုတ် image file)။",
  ambiguousAmount: "Caption မှာ ဂဏန်း တစ်ခုထက်ပိုနေပါတယ်။ ပမာဏ တစ်ခုတည်းပဲ ရေးပြီး ပုံကို ပြန်ပို့ပါ (ဥပမာ <code>95000</code>)။",
  disabled: "Slip စစ်စနစ် ပိတ်ထားပါတယ် (key မထည့်ရသေးပါ)။ Admin ကို အကြောင်းကြားပါ။",
  failed: "Slip ကို မစစ်နိုင်ပါဘူး။ ခဏနေပြီး ပြန်ပို့ကြည့်ပါ၊ မရရင် Admin ကို ပြပါ။",
  noAmountNote: "ℹ️ ပမာဏ မထည့်ထားလို့ ပမာဏ ကိုက်/မကိုက်ကို မစစ်ထားပါဘူး။",
  footer:
    "ℹ️ ဒါက slip ကို စစ်ချက်ပဲ ဖြစ်ပါတယ်။ ပိုက်ဆံ တကယ်ဝင်ကြောင်းကို bot က မမြင်ရပါဘူး — Admin က Bank/Wave app မှာ အတည်ပြုပါတယ်။",
};

const HEADER = {
  ok: "🟢 <b>အားလုံး ကိုက်ပါတယ်</b>",
  warn: "🟡 <b>မျက်စိနဲ့ ထပ်စစ်ပါ</b>",
  bad: "🔴 <b>ပြဿနာရှိပါတယ် — မအတည်ပြုပါနဲ့</b>",
  error: "⚠️ <b>အလိုအလျောက် မဖတ်နိုင်ပါ — မျက်စိနဲ့ စစ်ပါ</b>",
};

/** What this person may do in the staff bot, from the three settings. */
export function rolesOf(from, senders, approversList, adminId = "") {
  return { send: isStaff(from, senders, adminId), approve: isStaff(from, approversList, adminId) };
}

/** True when ADMIN_CHAT_ID holds more than one ID — the shop bot and this bot both
 *  compare it as ONE exact number, so a list there matches nobody. */
export function adminIdLooksWrong(adminId = "") {
  return /[,;\s]/.test(String(adminId).trim());
}

// Approvers are a separate list from senders. The admin (ADMIN_CHAT_ID) is always both.
export const isApprover = isStaff;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Buttons under a verdict. Green: one tap. Yellow/unreadable: "verified" or "no".
 *  Red: "no" leads and approving needs a second, confirming tap (same as the shop bot). */
export function approvalRows(level) {
  const lv = HEADER[level] ? level : "error";
  if (lv === "bad") {
    return [[
      { text: MSG.btnNo, callback_data: `ap:no:${lv}` },
      { text: MSG.btnAnyway, callback_data: `ap:ask:${lv}` },
    ]];
  }
  return [[
    { text: lv === "ok" ? MSG.btnOk : MSG.btnVerified, callback_data: `ap:ok:${lv}` },
    { text: MSG.btnNo, callback_data: `ap:no:${lv}` },
  ]];
}

export function confirmRows(level) {
  const lv = HEADER[level] ? level : "bad";
  return [[
    { text: MSG.btnConfirm, callback_data: `ap:ok:${lv}` },
    { text: MSG.btnBack, callback_data: `ap:back:${lv}` },
  ]];
}

/** "ap:ok:warn" → { action: "ok", level: "warn" }; anything else → null. */
export function parseApproval(data) {
  const m = /^ap:(ok|no|ask|back):(ok|warn|bad|error)$/.exec(String(data || ""));
  return m ? { action: m[1], level: m[2] } : null;
}

/** The line posted under the verdict once an approver decides (the audit trail). */
export function decisionText(action, level, who, timeStr) {
  const by = `${esc(who)} · ${esc(timeStr)}`;
  if (action === "no") return `❌ <b>မအတည်ပြုပါ</b> — ${by}`;
  if (level === "bad") return `⚠️ <b>ပြဿနာပြနေတာကို သိပြီး အတည်ပြုခဲ့ပါတယ်</b> — ${by}`;
  return `✅ <b>အတည်ပြုပြီး</b> — ${by}`;
}

/** The full reply for staff: Burmese verdict line, the checker's own detail
 *  block, a note when no amount was given, and the "bot can't see the bank" footer. */
export function formatVerdict(result, { hasAmount = true } = {}) {
  if (!result) return MSG.disabled;
  const head = HEADER[result.level] || HEADER.error;
  const parts = [head];
  if (result.html) parts.push(result.html);
  if (!hasAmount) parts.push(MSG.noAmountNote);
  parts.push(MSG.footer);
  return parts.join("\n\n");
}
