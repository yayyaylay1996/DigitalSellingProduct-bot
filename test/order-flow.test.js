// Run with:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ITEMS, newId, newDraft, cleanCustomer, parseEmail, parseAmountText, basketTotal, paymentCell, basketText,
  render, applyAction, applyText, textStep, parseOrderCb, parseSellerNames, sellerFor, orderDecisionText, yangonNow,
  itemRows, ITEMS_PER_PAGE,
} from "../order-flow-lib.js";
import { buildCatalog, paymentList } from "../desk-catalog.js";
import { buildStaffDeskRow } from "../desk.js";

const CONFIG = [
  ["List", "Value", "Needs Email", "Is Default", "Active", "Reminder", "Track"],
  ["Item", "Capcut", "FALSE", "TRUE", "TRUE", "FALSE", "TRUE"],
  ["Item", "Netflix", "FALSE", "FALSE", "TRUE", "FALSE", "TRUE"],
  ["Item", "Zoom Choice1", "TRUE", "TRUE", "TRUE", "TRUE", "TRUE"],
  ["Item", "Meitu SVIP", "FALSE", "FALSE", "FALSE", "FALSE", "TRUE"], // inactive
  ["Item", "Capcut", "FALSE", "FALSE", "TRUE", "FALSE", "TRUE"], // duplicate
  ["Item", "Wink", "FALSE", "FALSE", "", "FALSE", "FALSE"], // blank Active = active
  ["Source", "G-Tg", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
  ["Source", "Y-Tg", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
  ["Source", "Old", "FALSE", "TRUE", "FALSE", "FALSE", "FALSE"],
  ["Access", "Share", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
  ["Access", "Private", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
  ["Duration", "1Month", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
  ["Duration", "3Month", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
  ["Duration", "14 Days", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
  ["Supplier", "CFC", "FALSE", "TRUE", "TRUE", "FALSE", "FALSE"],
];
const PRICES = [
  ["Item", "Access", "Duration", "Price"],
  ["Capcut", "Private", "1Month", "25000"],
  ["capcut", "share", "3 Month", "30,000"], // spelling differs from Config → written the Config way
  ["Capcut", "Private", "1Month", "99999"], // duplicate plan: first wins
  ["Netflix", "Share", "1Month", "12000"],
  ["Zoom Pro", "Private", "1Month", "20000"], // not a Config item
  ["Capcut", "Weird", "1Month", "5000"], // access not in Config
  ["Netflix", "Private", "1Month", ""], // no price
];
const catalog = () => buildCatalog(CONFIG, PRICES, ["KPay", "Wave"]);

// ─── catalogue ───────────────────────────────────────────────────────────────

test("catalog: active Config values only, deduped, flags carried", () => {
  const c = catalog();
  assert.deepEqual(c.items.map((i) => i.name), ["Capcut", "Netflix", "Zoom Choice1", "Wink"]);
  assert.deepEqual(c.sources, ["G-Tg", "Y-Tg"]);
  assert.deepEqual(c.accesses, ["Share", "Private"]);
  assert.deepEqual(c.durations, ["1Month", "3Month", "14 Days"]);
  const zoom = c.items.find((i) => i.name === "Zoom Choice1");
  assert.equal(zoom.needsEmail, true);
  assert.equal(zoom.reminder, true);
  assert.equal(c.items.find((i) => i.name === "Wink").track, false);
});

test("catalog: prices use Config spelling; unknown items/values are left out and reported", () => {
  const c = catalog();
  assert.deepEqual(c.options.Capcut, [
    { access: "Private", duration: "1Month", price: 25000 },
    { access: "Share", duration: "3Month", price: 30000 },
  ]);
  assert.deepEqual(c.options.Netflix, [{ access: "Share", duration: "1Month", price: 12000 }]);
  assert.deepEqual(c.warnings.unknownItems, ["Zoom Pro"]);
  assert.equal(c.warnings.skippedRows, 2);
  assert.ok(c.warnings.itemsWithoutPrices.includes("Zoom Choice1"));
});

test("catalog: payment methods from the list given, else the defaults; empty Config falls back for sources", () => {
  assert.deepEqual(catalog().payments, ["KPay", "Wave"]);
  assert.deepEqual(paymentList("KPay, Wave ;KPay\nUAB"), ["KPay", "Wave", "UAB"]);
  assert.ok(paymentList("").includes("KPay"));
  assert.ok(buildCatalog([], []).sources.length > 0);
});

// ─── small helpers ───────────────────────────────────────────────────────────

test("newId: 4 safe characters", () => {
  for (let i = 0; i < 50; i++) assert.match(newId(), /^[A-HJ-NP-Z2-9]{4}$/);
});

test("cleanCustomer: trims, flattens, caps, and defuses formulas", () => {
  assert.equal(cleanCustomer("  Ma   Ma \n Aye "), "Ma Ma Aye");
  assert.equal(cleanCustomer("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(cleanCustomer("+959123"), "'+959123");
  assert.equal(cleanCustomer("@maung_maung"), "@maung_maung");
  assert.equal(cleanCustomer("   "), "");
  assert.equal(cleanCustomer("x".repeat(100)).length, 60);
});

test("parseEmail / parseAmountText", () => {
  assert.equal(parseEmail(" Mg.Mg@Gmail.com "), "mg.mg@gmail.com");
  assert.equal(parseEmail("not an email"), "");
  assert.equal(parseEmail("a@b"), "");
  assert.equal(parseAmountText("8,000 ks"), 8000);
  assert.equal(parseAmountText("၈၀၀၀"), 8000);
  assert.equal(parseAmountText("0"), null);
  assert.equal(parseAmountText("100 200"), null);
  assert.equal(parseAmountText("abc"), null);
  assert.equal(parseAmountText("999999999999"), null);
});

test("parseOrderCb: valid forms and junk", () => {
  assert.deepEqual(parseOrderCb("o:8F3K:src:2"), { id: "8F3K", action: "src", arg: "2" });
  assert.deepEqual(parseOrderCb("o:8F3K:cancel"), { id: "8F3K", action: "cancel", arg: "" });
  assert.deepEqual(parseOrderCb("o:8F3K:amt:auto"), { id: "8F3K", action: "amt", arg: "auto" });
  assert.equal(parseOrderCb("ap:ok:ok"), null);
  assert.equal(parseOrderCb("o:abc:src:1"), null);
  assert.equal(parseOrderCb(undefined), null);
});

// ─── driving a whole order ───────────────────────────────────────────────────

const tap = (d, action, arg = "", c = catalog()) => {
  const r = applyAction(d, { action, arg }, c);
  assert.ok(!r.toast && !r.cancel, `tap ${action} refused: ${r.toast}`);
  return r.draft;
};

function upToItem() {
  let d = newDraft({ id: "ABCD", ownerId: 7, ownerName: "Mg Mg", chatId: 1 });
  d = tap(d, "src", 1); // Y-Tg
  assert.equal(d.source, "Y-Tg");
  d = tap(d, "pay", 0); // KPay
  assert.equal(d.payment, "KPay");
  d = applyText(d, "Ma Ma (@mama)").draft;
  assert.equal(d.customer, "Ma Ma (@mama)");
  assert.equal(d.step, "item");
  return d;
}

test("order: two products on one payment, list price + typed price", () => {
  let d = upToItem();
  d = tap(d, "itm", 0); // Capcut
  assert.equal(d.step, "option");
  d = tap(d, "opt", 0); // Private 1Month 25000
  assert.equal(d.step, "amount");
  d = tap(d, "amt", "auto");
  assert.equal(d.step, "basket");
  assert.deepEqual(d.lines[0], { item: "Capcut", access: "Private", duration: "1Month", price: 25000, email: "", track: true });

  d = tap(d, "add");
  d = tap(d, "itm", 1); // Netflix
  d = tap(d, "opt", 0);
  d = tap(d, "amt", "man");
  assert.equal(d.step, "amount_text");
  assert.ok(textStep(d));
  d = applyText(d, "11,000").draft;
  assert.equal(d.lines.length, 2);
  assert.equal(basketTotal(d), 36000);

  d = tap(d, "done");
  assert.equal(d.step, "slip");
  assert.equal(paymentCell(d), "KPay · S-ABCD");
});

test("order: bad typed amount keeps the step and says so", () => {
  let d = upToItem();
  d = tap(d, "itm", 0);
  d = tap(d, "opt", 0);
  d = tap(d, "amt", "man");
  const r = applyText(d, "lots");
  assert.ok(r.toast);
  assert.equal(r.draft.step, "amount_text");
});

test("order: plan not on the price list → pick Access and Duration by hand, then type the price", () => {
  let d = upToItem();
  d = tap(d, "itm", 1); // Netflix
  d = tap(d, "mo");
  assert.equal(d.step, "access");
  d = tap(d, "acc", 1); // Private
  d = tap(d, "dur", 2); // 14 Days
  assert.equal(d.step, "amount_text");
  d = applyText(d, "9000").draft;
  assert.deepEqual(d.lines[0], { item: "Netflix", access: "Private", duration: "14 Days", price: 9000, email: "", track: true });
});

test("order: a product with no price list goes straight to manual Access/Duration", () => {
  let d = upToItem();
  d = tap(d, "itm", 3); // Wink — no prices
  assert.equal(d.step, "access");
  assert.equal(d.pending.track, false);
});

test("order: an option with no price asks for the amount", () => {
  const c = catalog();
  c.options.Netflix.push({ access: "Private", duration: "3Month", price: null });
  let d = upToItem();
  d = tap(d, "itm", 1, c);
  d = tap(d, "opt", 1, c);
  assert.equal(d.step, "amount_text");
  assert.equal(d.pending.listPrice, null);
});

test("order: Zoom asks for the email; skip leaves it blank; a bad email is refused", () => {
  let d = upToItem();
  d = tap(d, "itm", 2); // Zoom Choice1 (no prices → manual)
  d = tap(d, "acc", 1);
  d = tap(d, "dur", 1);
  d = applyText(d, "20000").draft;
  assert.equal(d.step, "email");
  assert.equal(d.lines.length, 0);
  assert.ok(applyText(d, "nope").toast);
  const withEmail = applyText(d, "Zoom.User@Gmail.com").draft;
  assert.equal(withEmail.lines[0].email, "zoom.user@gmail.com");
  assert.equal(withEmail.step, "basket");
  const skipped = tap(d, "skip");
  assert.equal(skipped.lines[0].email, "");
  assert.equal(skipped.lines[0].track, true);
});

test("order: at most 10 products", () => {
  let d = upToItem();
  for (let i = 0; i < MAX_ITEMS; i++) {
    d = tap(d, "itm", 0);
    d = tap(d, "opt", 0);
    d = tap(d, "amt", "auto");
    if (i < MAX_ITEMS - 1) d = tap(d, "add");
  }
  assert.equal(d.lines.length, MAX_ITEMS);
  const r = applyAction(d, { action: "add" }, catalog());
  assert.ok(r.toast);
  assert.equal(r.draft.lines.length, MAX_ITEMS);
  assert.ok(!render(d, catalog()).rows.flat().some((b) => /:add$/.test(b.callback_data)));
});

test("order: undo removes the last product; back from the slip step returns to the basket", () => {
  let d = upToItem();
  d = tap(d, "itm", 0); d = tap(d, "opt", 0); d = tap(d, "amt", "auto");
  d = tap(d, "add"); d = tap(d, "itm", 1); d = tap(d, "opt", 0); d = tap(d, "amt", "auto");
  d = tap(d, "undo");
  assert.equal(d.lines.length, 1);
  d = tap(d, "undo");
  assert.equal(d.lines.length, 0);
  assert.equal(d.step, "item");
  d = tap(d, "itm", 0); d = tap(d, "opt", 0); d = tap(d, "amt", "auto"); d = tap(d, "done");
  d = tap(d, "bk");
  assert.equal(d.step, "basket");
});

test("order: taps from an older panel are refused, cancel always works", () => {
  const d = upToItem(); // step: item
  const r = applyAction(d, { action: "src", arg: "0" }, catalog());
  assert.ok(r.toast);
  assert.equal(r.draft.step, "item");
  assert.ok(applyAction(d, { action: "cancel" }, catalog()).cancel);
  assert.ok(applyAction(d, { action: "opt", arg: "99" }, catalog()).toast);
});

test("render: every step has text and valid callback data", () => {
  const c = catalog();
  let d = newDraft({ id: "ABCD", ownerId: 7, ownerName: "Mg", chatId: 1 });
  const seen = new Set();
  const check = (draft) => {
    const { text, rows } = render(draft, c);
    assert.ok(text.includes("S-ABCD"));
    seen.add(draft.step);
    for (const b of rows.flat()) {
      assert.ok(Buffer.byteLength(b.callback_data) <= 64);
      assert.ok(parseOrderCb(b.callback_data), b.callback_data);
    }
  };
  check(d);
  d = tap(d, "src", 0); check(d);
  d = tap(d, "pay", 0); check(d);
  d = applyText(d, "Aye").draft; check(d);
  d = tap(d, "itm", 0); check(d);
  d = tap(d, "mo"); check(d);
  d = tap(d, "acc", 0); check(d);
  d = tap(d, "dur", 0); check(d);
  d = applyText(d, "5000").draft; check(d);
  d = tap(d, "done"); check(d);
  for (const s of ["source", "payment", "customer", "item", "access", "duration", "amount_text", "basket", "slip"]) assert.ok(seen.has(s), s);
});

test("item list pages", () => {
  const d = newDraft({ id: "ABCD", ownerId: 7, ownerName: "Mg", chatId: 1 });
  const items = Array.from({ length: 20 }, (_, i) => `Item ${i}`);
  const rows = itemRows(d, items, 1);
  const names = rows.flat().map((b) => b.text);
  assert.ok(names.includes("Item 8") && !names.includes("Item 0") && names.includes("◀️") && names.includes("▶️"));
  assert.equal(rows.flat().filter((b) => /:itm:/.test(b.callback_data)).length, ITEMS_PER_PAGE);
  const only = applyAction({ ...d, step: "item" }, { action: "pg", arg: "2" }, { items: items.map((name) => ({ name })), options: {} });
  assert.equal(only.draft.page, 2);
});

test("basketText: escapes names, shows total and count", () => {
  let d = upToItem();
  d = { ...d, customer: "<b>x</b>" };
  d = tap({ ...d, step: "item" }, "itm", 0);
  d = tap(d, "opt", 0); d = tap(d, "amt", "auto");
  const t = basketText(d);
  assert.ok(t.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(t.includes("25,000") && t.includes("1/10"));
});

// ─── Desk rows ───────────────────────────────────────────────────────────────

test("buildStaffDeskRow: 21 cells in the Desk's formats; 20 without the Payment column", () => {
  const draft = { source: "Y-Tg", customer: "Ma Ma", payment: "KPay", ref: "S-8F3K" };
  const line = { item: "Capcut", access: "Private", duration: "1Month", price: 25000, email: "", track: true };
  const row = buildStaffDeskRow({ no: 1362, line, draft, dateTime: "2026-10-13 14:05", seller: "Mg Mg" });
  assert.equal(row.length, 21);
  assert.deepEqual(row.slice(0, 5), [1362, "13/10/2026", "Ma Ma", "14:05", ""]);
  assert.deepEqual(row.slice(5, 14), ["Y-Tg", "Capcut", "Mg Mg", "", 25000, "Private", "Done", "1Month", ""]);
  assert.equal(row[15], true); // Track
  assert.equal(row[16], "2026-11-13"); // Expiry Date YYYY-MM-DD
  assert.equal(row[19], false); // Reminder
  assert.equal(row[20], "KPay · S-8F3K");
  const old = buildStaffDeskRow({ no: 1, line, draft, dateTime: "2026-10-13 14:05", seller: "x", includePayment: false });
  assert.equal(old.length, 20);
});

test("buildStaffDeskRow: 14 Days, Zoom email, untracked item", () => {
  const draft = { source: "G-Tg", customer: "A", payment: "Wave", ref: "S-AAAA" };
  const row = buildStaffDeskRow({
    no: 5, draft, dateTime: "2026-01-20 09:00", seller: "S",
    line: { item: "Zoom Choice1", access: "Private", duration: "14 Days", price: 8500, email: "a@b.co", track: false },
  });
  assert.equal(row[13], "a@b.co");
  assert.equal(row[15], false);
  assert.equal(row[16], "2026-02-03");
});

// ─── names and messages ──────────────────────────────────────────────────────

test("seller names: by ID or username, else the Telegram name", () => {
  const m = parseSellerNames("123=Mg Mg, @Ma_Ma=Ma Ma;bad;=x");
  assert.equal(m.get("123"), "Mg Mg");
  assert.equal(m.get("ma_ma"), "Ma Ma");
  assert.equal(m.size, 2);
  const d = { ownerId: "123", ownerName: "Someone" };
  assert.equal(sellerFor(d, { username: "x" }, m), "Mg Mg");
  assert.equal(sellerFor({ ownerId: "9", ownerName: "Zed" }, { username: "MA_MA" }, m), "Ma Ma");
  assert.equal(sellerFor({ ownerId: "9", ownerName: "Zed" }, null, m), "Zed");
  assert.equal(sellerFor({ ownerId: "9", ownerName: "=Zed" }, null, m), "'=Zed");
});

test("orderDecisionText: written rows with a range, missing Payment column noted, rejection writes nothing", () => {
  const d = { ref: "S-8F3K", lines: [{ price: 10 }, { price: 20 }, { price: 30 }] };
  const ok = orderDecisionText("ok", d, { nos: [1362, 1363, 1364], paymentColumn: true }, "@yay");
  assert.ok(ok.includes("1362–1364") && ok.includes("60") && !ok.includes("Payment”"));
  assert.ok(orderDecisionText("ok", d, { nos: [7], paymentColumn: false }, "@yay").includes("Payment"));
  assert.ok(orderDecisionText("no", d, null, "@yay").includes("မအတည်ပြုပါ"));
});

test("yangonNow: YYYY-MM-DD HH:MM in Myanmar time", () => {
  assert.equal(yangonNow(new Date("2026-10-13T00:00:00Z")), "2026-10-13 06:30");
  assert.equal(yangonNow(new Date("2026-10-13T18:00:00Z")), "2026-10-14 00:30");
});

// ─── ⬅️ Back ─────────────────────────────────────────────────────────────────

const bk = (d, c = catalog()) => tap(d, "bk", "", c);

test("back: undoes one choice at a time from source to item", () => {
  let d = newDraft({ id: "ABCD", ownerId: 7, ownerName: "Mg", chatId: 1 });
  assert.ok(applyAction(d, { action: "bk" }, catalog()).toast, "nowhere to go back from the first step");
  d = tap(d, "src", 0); d = tap(d, "pay", 1);
  d = applyText(d, "Aye").draft;
  assert.equal(d.step, "item");
  d = bk(d); assert.equal(d.step, "customer");
  d = applyText(d, "Aye Aye").draft; assert.equal(d.customer, "Aye Aye"); // retyping replaces the name
  d = bk(bk(d)); assert.equal(d.step, "payment"); assert.equal(d.payment, "");
  d = bk(d); assert.equal(d.step, "source"); assert.equal(d.source, "");
});

test("back: through the list-price path (item → plan → amount → typed amount)", () => {
  let d = upToItem();
  d = tap(d, "itm", 0);
  assert.equal(bk(d).step, "item");
  assert.equal(bk(d).pending, null);
  d = tap(d, "opt", 0);
  const fromAmount = bk(d);
  assert.equal(fromAmount.step, "option");
  assert.deepEqual(fromAmount.pending, { item: "Capcut", needsEmail: false, track: true }); // plan choice undone, item kept
  d = tap(d, "amt", "man");
  assert.equal(bk(d).step, "amount"); // typed-amount → back to the list price / typed choice
  assert.equal(bk(d).pending.listPrice, 25000);
});

test("back: an option without a price returns to the plan list", () => {
  const c = catalog();
  c.options.Netflix.push({ access: "Private", duration: "3Month", price: null });
  let d = upToItem();
  d = tap(d, "itm", 1, c); d = tap(d, "opt", 1, c);
  assert.equal(d.step, "amount_text");
  const b = bk(d, c);
  assert.equal(b.step, "option");
  assert.equal(b.pending.access, undefined);
});

test("back: manual plan path walks Access ← Duration ← typed amount, keeping what is still valid", () => {
  let d = upToItem();
  d = tap(d, "itm", 1); d = tap(d, "mo");
  assert.equal(bk(d).step, "option"); // the item has a price list, so back from Access shows it again
  d = tap(d, "acc", 1); d = tap(d, "dur", 2);
  assert.equal(d.step, "amount_text");
  const toDuration = bk(d);
  assert.equal(toDuration.step, "duration");
  assert.equal(toDuration.pending.access, "Private");
  assert.equal(toDuration.pending.duration, undefined);
  const toAccess = bk(toDuration);
  assert.equal(toAccess.step, "access");
  assert.equal(toAccess.pending.access, undefined);
  // and the corrected choice still ends in the right line
  let e = tap(toDuration, "dur", 1);
  e = applyText(e, "9000").draft;
  assert.deepEqual(e.lines[0], { item: "Netflix", access: "Private", duration: "3Month", price: 9000, email: "", track: true });
});

test("back: a product with no price list goes back to the product list from Access", () => {
  let d = upToItem();
  d = tap(d, "itm", 3); // Wink
  assert.equal(d.step, "access");
  const b = bk(d);
  assert.equal(b.step, "item");
  assert.equal(b.pending, null);
});

test("back: email step returns to the amount that was given; nothing is added to the basket", () => {
  let d = upToItem();
  d = tap(d, "itm", 2); d = tap(d, "acc", 1); d = tap(d, "dur", 1);
  d = applyText(d, "20000").draft;
  assert.equal(d.step, "email");
  const b = bk(d);
  assert.equal(b.step, "amount_text");
  assert.equal(b.pending.price, undefined);
  assert.equal(b.lines.length, 0);
  // list-price route: back lands on the amount choice
  const c = catalog();
  c.options["Zoom Choice1"] = [{ access: "Private", duration: "1Month", price: 20000 }];
  let z = upToItem();
  z = tap(z, "itm", 2, c); z = tap(z, "opt", 0, c); z = tap(z, "amt", "auto", c);
  assert.equal(z.step, "email");
  assert.equal(bk(z, c).step, "amount");
});

test("back: with products already in the basket, the product list goes back to the basket", () => {
  let d = upToItem();
  d = tap(d, "itm", 0); d = tap(d, "opt", 0); d = tap(d, "amt", "auto");
  d = tap(d, "add");
  assert.equal(d.step, "item");
  const b = bk(d);
  assert.equal(b.step, "basket");
  assert.equal(b.lines.length, 1);
});

test("back: slip step returns to the basket; basket has its own undo instead", () => {
  let d = upToItem();
  d = tap(d, "itm", 0); d = tap(d, "opt", 0); d = tap(d, "amt", "auto"); d = tap(d, "done");
  d = bk(d);
  assert.equal(d.step, "basket");
  assert.ok(applyAction(d, { action: "bk" }, catalog()).toast);
});

test("render: every step after the first has a Back button; the first and the basket do not", () => {
  const c = catalog();
  const hasBack = (d) => render(d, c).rows.flat().some((b) => /:bk$/.test(b.callback_data));
  let d = newDraft({ id: "ABCD", ownerId: 7, ownerName: "Mg", chatId: 1 });
  assert.equal(hasBack(d), false);
  d = tap(d, "src", 0); assert.equal(hasBack(d), true); // payment
  d = tap(d, "pay", 0); assert.equal(hasBack(d), true); // customer
  d = applyText(d, "Aye").draft; assert.equal(hasBack(d), true); // item
  d = tap(d, "itm", 0); assert.equal(hasBack(d), true); // option
  d = tap(d, "opt", 0); assert.equal(hasBack(d), true); // amount
  d = tap(d, "amt", "man"); assert.equal(hasBack(d), true); // amount_text
  d = applyText(d, "5000").draft; assert.equal(hasBack(d), false); // basket (has Undo)
  d = tap(d, "done"); assert.equal(hasBack(d), true); // slip
});
