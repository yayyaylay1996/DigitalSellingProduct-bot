/**
 * Pure logic for the staff order flow (staff-bot.js): the order "basket", the
 * steps, the button layouts and the text. No Telegram, Google or network access
 * here, so all of it is covered by `npm test`.
 *
 * One payment (one slip) can pay for several products. The basket holds up to
 * MAX_ITEMS lines; the slip is checked ONCE against the basket total, and an
 * approver's single tap writes one Desk row per line.
 *
 * A draft is a plain object that lives in memory in staff-bot.js. Every function
 * below returns a NEW draft (or null when the move isn't allowed).
 */
import { parseCaptionAmount } from "./staff-bot-lib.js";

export const MAX_ITEMS = 10;
export const DEFAULT_SOURCES = ["G-Tik", "G-Tg", "Y-Tg", "Y-Viber", "Y-Mesg"];
export const DEFAULT_PAYMENTS = ["KPay", "Wave", "UAB", "CB", "AYA", "Thai bank"];
export const ITEMS_PER_PAGE = 8;
export const MAX_AMOUNT = 100_000_000;

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid misreading

/** 4 characters, e.g. "8F3K". Used in callback data and in the draft's ref. */
export function newId(rand = Math.random) {
  let s = "";
  for (let i = 0; i < 4; i++) s += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
  return s;
}

export function newDraft({ id, ownerId, ownerName, chatId, now = Date.now() }) {
  return {
    id,
    ref: `S-${id}`, // the payment's reference: shown to staff, stored in the Desk and Slips sheet
    ownerId: String(ownerId),
    ownerName: ownerName || String(ownerId),
    chatId,
    step: "source", // source → payment → customer → item → option (→ access → duration) → amount (→ amount_text) → (email) → basket → slip
    source: "",
    payment: "",
    customer: "",
    pending: null, // the line being built: { item, needsEmail, track, access, duration, listPrice, price }
    lines: [], // finished lines: { item, access, duration, price, email, track }
    status: "open", // open → done | cancelled (a finished draft can never be written twice)
    createdAt: now,
  };
}

// ─── steps ───────────────────────────────────────────────────────────────────

export const setSource = (d, source) => (source ? { ...d, source, step: "payment" } : null);
export const setPayment = (d, payment) => (payment ? { ...d, payment, step: "customer" } : null);

/** Trim, collapse spaces, drop control characters, cap the length. A leading
 *  = + - would make Google Sheets treat the cell as a formula, so those get a
 *  leading apostrophe (Sheets shows it as plain text). */
export function cleanCustomer(text) {
  let t = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!t) return "";
  if (/^[=+\-]/.test(t)) t = `'${t}`;
  return t;
}

export function setCustomer(d, text) {
  const customer = cleanCustomer(text);
  return customer ? { ...d, customer, step: "item" } : null;
}

/** `entry` is a catalogue item: { name, needsEmail, track }. */
export function pickItem(d, entry) {
  if (!entry?.name) return null;
  return { ...d, pending: { item: entry.name, needsEmail: !!entry.needsEmail, track: entry.track !== false }, step: "option" };
}

/** option = { access, duration, price } where price may be null (not on the price list).
 *  No list price → the person types the amount; otherwise offer the list price too. */
export function pickOption(d, option) {
  if (!d.pending || !option) return null;
  const listPrice = Number.isFinite(option.price) && option.price > 0 ? option.price : null;
  return {
    ...d,
    pending: { ...d.pending, access: option.access || "", duration: option.duration || "", listPrice },
    step: listPrice ? "amount" : "amount_text",
  };
}

/** "Other plan": the product has no usable price-list row, so pick Access then Duration by hand. */
export const startManualOption = (d) => (d.pending ? { ...d, step: "access" } : null);
export const pickAccess = (d, access) => (d.pending && access ? { ...d, pending: { ...d.pending, access }, step: "duration" } : null);
export const pickDuration = (d, duration) =>
  d.pending && duration ? { ...d, pending: { ...d.pending, duration, listPrice: null }, step: "amount_text" } : null;

/** What "type a different amount" means: ask for the typed amount next. */
export const askTypedAmount = (d) => (d.pending ? { ...d, step: "amount_text" } : null);

/** Read an amount a person typed: one number, > 0, not absurd. */
export function parseAmountText(text) {
  const { amount, ambiguous } = parseCaptionAmount(text);
  if (ambiguous || amount == null) return null;
  if (!(amount > 0) || amount > MAX_AMOUNT) return null;
  return amount;
}

/** A customer email as typed; "" when it doesn't look like one. */
export function parseEmail(text) {
  const t = String(text ?? "").trim().toLowerCase();
  return t.length <= 120 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(t) ? t : "";
}

const addLine = (d, line) => ({ ...d, lines: [...d.lines, line], pending: null, step: "basket" });

/** Finish the pending line with `amount`. Products that need an email (Zoom) ask for it
 *  next; the rest go straight into the basket. null when the basket is full. */
export function confirmAmount(d, amount) {
  if (!d.pending || !(amount > 0) || d.lines.length >= MAX_ITEMS) return null;
  if (d.pending.needsEmail) return { ...d, pending: { ...d.pending, price: amount }, step: "email" };
  const { item, access, duration, track } = d.pending;
  return addLine(d, { item, access, duration, price: amount, email: "", track });
}

/** Give the email for the pending Zoom-type line, or "" to leave it blank for now. */
export function finishWithEmail(d, email) {
  if (!d.pending || d.step !== "email" || !(d.pending.price > 0) || d.lines.length >= MAX_ITEMS) return null;
  const { item, access, duration, track, price } = d.pending;
  return addLine(d, { item, access, duration, price, email: email || "", track });
}

export const canAddMore = (d) => d.lines.length < MAX_ITEMS;
export const startAnotherItem = (d) => (canAddMore(d) ? { ...d, pending: null, step: "item" } : null);

export function removeLastLine(d) {
  if (!d.lines.length) return null;
  const lines = d.lines.slice(0, -1);
  return { ...d, lines, pending: null, step: lines.length ? "basket" : "item" };
}

export const readyForSlip = (d) => (d.lines.length ? { ...d, step: "slip" } : null);
export const basketTotal = (d) => d.lines.reduce((s, l) => s + l.price, 0);

/** The text in the Desk's Payment column: "KPay · S-8F3K". */
export const paymentCell = (d) => `${d.payment} · ${d.ref}`;

// ─── text ────────────────────────────────────────────────────────────────────

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const fmt = (n) => Number(n).toLocaleString("en-US");

const lineLabel = (l) => [l.item, l.access, l.duration].filter(Boolean).join(" · ");

export function basketText(d, { final = false } = {}) {
  const head = `🧾 <b>Order</b> <code>${esc(d.ref)}</code>`;
  const who = [
    d.customer && `ဝယ်သူ: <b>${esc(d.customer)}</b>`,
    d.source && `Source: ${esc(d.source)}`,
    d.payment && `ငွေပေးချေမှု: ${esc(d.payment)}`,
  ].filter(Boolean).join(" · ");
  const lines = d.lines.map((l, i) => `${i + 1}. ${esc(lineLabel(l))} — ${fmt(l.price)}`);
  const pending = d.pending?.item ? [`➡️ ${esc(lineLabel(d.pending))}…`] : [];
  const parts = [head];
  if (who) parts.push(who);
  if (lines.length || pending.length) parts.push([...lines, ...pending].join("\n"));
  if (lines.length) {
    parts.push(`စုစုပေါင်း: <b>${fmt(basketTotal(d))}</b> Ks · ${d.lines.length}/${MAX_ITEMS} ခု${final ? "" : ""}`);
  }
  return parts.join("\n");
}

export const PROMPT = {
  source: "📍 <b>Order ဘယ်ကလာတာလဲ?</b> (Source)",
  payment: "💳 <b>ငွေကို ဘယ်နည်းနဲ့ ပေးခဲ့လဲ?</b>",
  customer: "👤 <b>ဝယ်သူရဲ့ နာမည် / @username</b> ကို ရိုက်ပို့ပါ။",
  item: "🛍 <b>Product ရွေးပါ</b>",
  option: "⏱ <b>Duration / Plan ရွေးပါ</b>",
  access: "🔑 <b>Access</b> (Share / Private …) ရွေးပါ",
  duration: "⏱ <b>Duration</b> ရွေးပါ",
  email: "📧 ဒီ product အတွက် <b>customer ရဲ့ email</b> ကို ရိုက်ပို့ပါ (မသိသေးရင် “နောက်မှ” ကို နှိပ်ပါ)။",
  badEmail: "Email မမှန်ပါ — ပြန်ရိုက်ပါ၊ ဒါမှမဟုတ် “နောက်မှ” ကို နှိပ်ပါ။",
  amount: "💰 <b>ပမာဏ</b> — စာရင်းဈေးအတိုင်းလား၊ ကိုယ်တိုင်ရိုက်မလား?",
  amountText: "✏️ ဒီ product ရဲ့ <b>ပမာဏ</b> ကို ဂဏန်းနဲ့ ရိုက်ပို့ပါ (ဥပမာ <code>8000</code>)။",
  badAmount: "ပမာဏ မမှန်ပါ။ ဂဏန်း တစ်ခုတည်း ရိုက်ပါ (ဥပမာ <code>8000</code>)။",
  badCustomer: "နာမည် ရိုက်ပို့ပါ။",
  basket: "👇 Product ထပ်ထည့်မလား၊ ပြီးပြီလား?",
  basketFull: `Product ${MAX_ITEMS} ခု ပြည့်ပါပြီ — ပိုမထည့်နိုင်ပါဘူး။`,
  slip: (d) =>
    `📷 <b>Slip ပုံကို ပို့ပါ</b> — စုစုပေါင်း <b>${fmt(basketTotal(d))}</b> Ks နဲ့ တိုက်စစ်ပါမယ်။\n` +
    `(Slip တစ်ပုံတည်းနဲ့ product ${d.lines.length} ခုလုံးအတွက် ပါ။ ပုံကို ပြန်ပို့ချင်ရင် ဒီအတိုင်း ထပ်ပို့လို့ရပါတယ်။)`,
  notYours: "ဒီ order က တခြားသူရဲ့ပါ — ကိုယ်တိုင် /order နဲ့ စပါ။",
  expired: "ဒီ order draft က သက်တမ်းကုန်သွားပါပြီ (bot restart ဖြစ်တာ ဒါမှမဟုတ် ကြာလွန်းတာ)။ /order နဲ့ ပြန်စပါ။",
  cancelled: "🗑 Order ကို မလုပ်တော့ပါဘူး။",
  needOrderFirst: "Order အရင်စပါ — /order လို့ ရိုက်ပါ။",
  slipTooEarly: "Order မပြီးသေးပါ — product တွေ ထည့်ပြီး “✅ ပြီးပြီ — slip ပို့မယ်” ကို အရင်နှိပ်ပါ။ (မလုပ်တော့ရင် /cancel)",
  stale: "ဒီခလုတ်က အသက်မဝင်တော့ပါဘူး။",
  sentToApprovers: "📨 Approver ဆီ ပို့ပြီးပါပြီ — အတည်ပြုရင် ဒီမှာ အကြောင်းပြန်ပါမယ်။",
  noApprovers: "⚠️ Approver ဆီ မပို့နိုင်ပါ (သူတို့က ဒီ bot ကို /start မလုပ်ရသေးတာ ဖြစ်နိုင်ပါတယ်)။ Group ထဲကနေ ပို့ပါ၊ ဒါမှမဟုတ် Admin ကို ပြောပါ။",
  checkingBusy: "Slip ကို စစ်နေဆဲပါ — ခဏစောင့်ပါ။",
  noCatalog: "Product စာရင်း မဖတ်နိုင်သေးပါဘူး — ခဏနေပြီး ပြန်ကြိုးစားပါ၊ မရရင် Admin ကို ပြောပါ။",
};

// ─── buttons ─────────────────────────────────────────────────────────────────

const cb = (d, action, arg = "") => `o:${d.id}:${action}${arg === "" ? "" : `:${arg}`}`;
const btn = (text, data) => ({ text, callback_data: data });
export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const cancelRow = (d) => [btn("🗑 မလုပ်တော့ဘူး", cb(d, "cancel"))];

export const sourceRows = (d, sources) => [...chunk(sources.map((s, i) => btn(s, cb(d, "src", i))), 3), cancelRow(d)];
export const paymentRows = (d, payments) => [...chunk(payments.map((p, i) => btn(p, cb(d, "pay", i))), 3), cancelRow(d)];

/** Product list, a page at a time. Callback carries the index into the full list. */
export function itemRows(d, items, page = 0) {
  const pages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = items.slice(p * ITEMS_PER_PAGE, (p + 1) * ITEMS_PER_PAGE);
  const rows = chunk(slice.map((name, i) => btn(name, cb(d, "itm", p * ITEMS_PER_PAGE + i))), 2);
  if (pages > 1) {
    const nav = [];
    if (p > 0) nav.push(btn("◀️", cb(d, "pg", p - 1)));
    nav.push(btn(`${p + 1}/${pages}`, cb(d, "noop")));
    if (p < pages - 1) nav.push(btn("▶️", cb(d, "pg", p + 1)));
    rows.push(nav);
  }
  rows.push(cancelRow(d));
  return rows;
}

/** Plan options for the chosen product: "Private · 1Month · 8,000", plus "other plan". */
export const optionRows = (d, options) => [
  ...options.slice(0, 20).map((o, i) =>
    [btn([o.access, o.duration].filter(Boolean).join(" · ") + (o.price ? ` · ${fmt(o.price)}` : " · (ဈေးမရှိ)"), cb(d, "opt", i))]
  ),
  [btn("✏️ တခြား plan (ကိုယ်တိုင်ရွေး)", cb(d, "mo"))],
  cancelRow(d),
];

export const accessRows = (d, accesses) => [...chunk(accesses.map((a, i) => btn(a, cb(d, "acc", i))), 3), cancelRow(d)];
export const durationRows = (d, durations) => [...chunk(durations.map((x, i) => btn(x, cb(d, "dur", i))), 3), cancelRow(d)];
export const emailRows = (d) => [[btn("နောက်မှ ထည့်မယ်", cb(d, "skip"))], cancelRow(d)];

export function amountRows(d) {
  const rows = [];
  const lp = d.pending?.listPrice;
  if (lp) rows.push([btn(`💰 ${fmt(lp)} (စာရင်းဈေး)`, cb(d, "amt", "auto"))]);
  rows.push([btn("✏️ ကိုယ်တိုင် ရိုက်မယ်", cb(d, "amt", "man"))]);
  rows.push(cancelRow(d));
  return rows;
}

export function basketRows(d) {
  const rows = [];
  if (canAddMore(d)) rows.push([btn("➕ Product ထပ်ထည့်", cb(d, "add"))]);
  rows.push([btn("✅ ပြီးပြီ — slip ပို့မယ်", cb(d, "done"))]);
  rows.push([btn("↩️ နောက်ဆုံးတစ်ခု ဖျက်", cb(d, "undo")), btn("🗑 မလုပ်တော့ဘူး", cb(d, "cancel"))]);
  return rows;
}

/** "o:8F3K:src:2" → { id: "8F3K", action: "src", arg: "2" }; anything else → null. */
export function parseOrderCb(data) {
  const m = /^o:([A-Z2-9]{4}):([a-z]{2,8})(?::(\d{1,3}|auto|man))?$/.exec(String(data || ""));
  return m ? { id: m[1], action: m[2], arg: m[3] ?? "" } : null;
}

// ─── time ────────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD HH:MM" in Myanmar time, whatever timezone the server is in. */
export function yangonNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Yangon", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

// ─── driving the draft from button taps and typed text ───────────────────────

/** Steps where the person types a reply instead of tapping. */
export const textStep = (d) => d.step === "customer" || d.step === "amount_text" || d.step === "email";

/** The panel (text + buttons) for the draft's current step. `catalog` is from desk-catalog.js. */
export function render(d, catalog) {
  const head = basketText(d);
  const say = (prompt, rows) => ({ text: `${head}\n\n${prompt}`, rows });
  const cancelOnly = [cancelRow(d)];
  switch (d.step) {
    case "source": return say(PROMPT.source, sourceRows(d, catalog.sources));
    case "payment": return say(PROMPT.payment, paymentRows(d, catalog.payments));
    case "customer": return say(PROMPT.customer, cancelOnly);
    case "item": return say(PROMPT.item, itemRows(d, catalog.items.map((i) => i.name), d.page || 0));
    case "option": return say(PROMPT.option, optionRows(d, catalog.options[d.pending?.item] || []));
    case "access": return say(PROMPT.access, accessRows(d, catalog.accesses));
    case "duration": return say(PROMPT.duration, durationRows(d, catalog.durations));
    case "amount": return say(PROMPT.amount, amountRows(d));
    case "amount_text": return say(PROMPT.amountText, cancelOnly);
    case "email": return say(PROMPT.email, emailRows(d));
    case "basket": return say(PROMPT.basket, basketRows(d));
    case "slip": return say(PROMPT.slip(d), [[btn("↩️ Basket ပြန်ပြင်", cb(d, "back"))], cancelRow(d)]);
    default: return { text: head, rows: [] };
  }
}

/** Which step each button belongs to. A tap on an older panel is refused, not guessed at. */
const ACTION_STEP = {
  src: "source", pay: "payment", itm: "item", pg: "item", opt: "option", mo: "option",
  acc: "access", dur: "duration", amt: "amount", skip: "email",
  add: "basket", done: "basket", undo: "basket", back: "slip",
};

/**
 * Apply one button tap. Returns { draft, toast } (draft unchanged + a toast when the tap
 * doesn't fit), or { cancel: true }. Pure: no Telegram, no Google.
 */
export function applyAction(d, { action, arg = "" }, catalog) {
  if (action === "cancel") return { cancel: true };
  if (action === "noop") return { draft: d };
  const stale = { draft: d, toast: PROMPT.stale };
  if (action === "undo" && d.step === "slip") return stale;
  if (ACTION_STEP[action] !== d.step) return stale;
  const idx = /^\d+$/.test(arg) ? Number(arg) : -1;
  let next = null;
  switch (action) {
    case "src": next = setSource(d, catalog.sources[idx]); break;
    case "pay": next = setPayment(d, catalog.payments[idx]); break;
    case "pg": next = { ...d, page: idx >= 0 ? idx : 0 }; break;
    case "itm": {
      const entry = catalog.items[idx];
      next = pickItem(d, entry);
      // No price list for this product → straight to picking Access / Duration by hand.
      if (next && !catalog.options[entry.name]?.length) next = startManualOption(next);
      break;
    }
    case "opt": next = pickOption(d, (catalog.options[d.pending?.item] || [])[idx]); break;
    case "mo": next = startManualOption(d); break;
    case "acc": next = pickAccess(d, catalog.accesses[idx]); break;
    case "dur": next = pickDuration(d, catalog.durations[idx]); break;
    case "amt":
      if (arg === "auto") next = d.pending?.listPrice ? confirmAmount(d, d.pending.listPrice) : null;
      else if (arg === "man") next = askTypedAmount(d);
      break;
    case "skip": next = finishWithEmail(d, ""); break;
    case "add": next = startAnotherItem(d); if (!next) return { draft: d, toast: PROMPT.basketFull }; break;
    case "done": next = readyForSlip(d); break;
    case "undo": next = removeLastLine(d); break;
    case "back": next = { ...d, step: "basket" }; break;
  }
  return next ? { draft: next } : stale;
}

/** Apply typed text for the current text step. Returns { draft } or { draft, toast } when it isn't usable. */
export function applyText(d, text) {
  if (d.step === "customer") {
    const next = setCustomer(d, text);
    return next ? { draft: next } : { draft: d, toast: PROMPT.badCustomer };
  }
  if (d.step === "amount_text") {
    const amount = parseAmountText(text);
    const next = amount ? confirmAmount(d, amount) : null;
    return next ? { draft: next } : { draft: d, toast: PROMPT.badAmount };
  }
  if (d.step === "email") {
    const email = parseEmail(text);
    const next = email ? finishWithEmail(d, email) : null;
    return next ? { draft: next } : { draft: d, toast: PROMPT.badEmail };
  }
  return { draft: d };
}

/** "123456789=Mg Mg, 987654321=Ma Ma" → Map(id → Desk "Seller Name"). */
export function parseSellerNames(raw = "") {
  const m = new Map();
  for (const part of String(raw).split(/[,;\n]+/)) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const id = part.slice(0, i).trim().replace(/^@/, "").toLowerCase();
    const name = cleanCustomer(part.slice(i + 1));
    if (id && name) m.set(id, name);
  }
  return m;
}

/** Seller Name for the Desk: the STAFF_SELLER_NAMES entry (by ID or username), else the person's Telegram name. */
export function sellerFor(draft, from, map = new Map()) {
  const byId = map.get(String(draft.ownerId));
  const byUser = from?.username ? map.get(String(from.username).toLowerCase()) : "";
  return byId || byUser || cleanCustomer(draft.ownerName) || String(draft.ownerId);
}

/** The Telegram-facing result of a decision on an order, for the staff member. */
export function orderDecisionText(action, d, desk, who) {
  const by = esc(who);
  if (action === "no") {
    return `❌ <code>${esc(d.ref)}</code> — မအတည်ပြုပါ (${by})။ Slip အသစ် ပို့နိုင်ပါတယ် (ဒီ order ထဲမှာ ဆက်ပို့လို့ရပါတယ်) ဒါမှမဟုတ် /cancel`;
  }
  const nos = desk.nos;
  const range = nos.length > 1 ? `${nos[0]}–${nos[nos.length - 1]}` : String(nos[0]);
  const lines = [`✅ <code>${esc(d.ref)}</code> — အတည်ပြုပြီး၊ Order Desk ထဲ ထည့်ပြီးပါပြီ (No. ${range} · ${nos.length} ခု · ${fmt(basketTotal(d))} Ks)`];
  if (!desk.paymentColumn) lines.push("ℹ️ Orders sheet မှာ “Payment” column (U) မရှိသေးလို့ ငွေပေးချေမှုကို မရေးထားပါ။");
  return lines.join("\n");
}
