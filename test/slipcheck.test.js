// Run with:  npm test
// Uses the two real KBZPay e-receipts as fixtures (fields transcribed by hand),
// so the checking rules are tested without any network or Google access.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSlip, parseReceivers, txnKeyOf, keyWarning, isKeyProblem, slipProviders, slipIsComplete, parseBurmeseAmount, parseBurmeseDateTime, normalizeBurmese, reconcile, needsSecondOpinion } from "../slipcheck.js";

const RECEIVERS = parseReceivers("Zin Mar Win|1111");

// Sample 1: 08/10/2026 16:46:13 Myanmar time, 12,000 Ks
const slip1 = {
  is_payment_slip: true, provider: "KBZPay", status: "success", amount: 12000, currency: "MMK",
  transaction_datetime: "2026-10-08T16:46:13", transaction_id: "01000000000000000001",
  receiver_name: "Zin Mar Win", receiver_account_tail: "1111", legibility: "clear", edit_signs: [],
};
// Sample 2: 12/09/2026 13:58:36, 25,000 Ks
const slip2 = {
  ...slip1, amount: 25000, transaction_datetime: "2026-09-12T13:58:36", transaction_id: "01000000000000000002",
};

// 16:46:13 Myanmar time (UTC+6:30) is 10:16:13 UTC.
const slip1Utc = Date.UTC(2026, 9, 8, 10, 16, 13);
const base = (over = {}) => ({
  expectedAmount: 12000, ref: "ORD-0100", nowMs: slip1Utc + 20 * 60000,
  priorRows: [], dupCheckFailed: false, receivers: RECEIVERS, maxAgeMin: 120, defaultOffsetMin: 390, ...over,
});
const has = (r, status, re) => r.checks.some((c) => c.status === status && re.test(c.text));

test("a matching, fresh, new slip passes", () => {
  const r = evaluateSlip(slip1, base());
  assert.equal(r.level, "ok");
  assert.ok(has(r, "ok", /matches the order/));
  assert.ok(has(r, "ok", /your account/));
  assert.ok(has(r, "ok", /is new/));
  assert.equal(r.txnKey, "01000000000000000001");
});

test("wrong amount is a problem", () => {
  const r = evaluateSlip({ ...slip1, amount: 5000 }, base());
  assert.equal(r.level, "bad");
  assert.ok(has(r, "bad", /order is 12,000/));
});

test("an old slip is flagged", () => {
  const r = evaluateSlip(slip2, base({ expectedAmount: 25000, nowMs: slip1Utc }));
  assert.equal(r.level, "warn");
  assert.ok(has(r, "warn", /Old slip/));
});

test("same txn number on another order is a problem; on the same order it is fine", () => {
  const prior = [{ ref: "ORD-0042", seenAt: "2026-10-08 16:50" }];
  const dup = evaluateSlip(slip1, base({ priorRows: prior }));
  assert.equal(dup.level, "bad");
  assert.ok(has(dup, "bad", /already used for ORD-0042/));
  const same = evaluateSlip(slip1, base({ priorRows: [{ ref: "ORD-0100", seenAt: "x" }] }));
  assert.equal(same.level, "ok");
});

test("money sent to someone else is a problem", () => {
  const r = evaluateSlip({ ...slip1, receiver_name: "Someone Else", receiver_account_tail: "7777" }, base());
  assert.equal(r.level, "bad");
  assert.ok(has(r, "bad", /not one of your accounts/));
});

test("receiver is matched by last digits alone, or by name alone", () => {
  assert.equal(evaluateSlip({ ...slip1, receiver_name: "" }, base()).level, "ok");
  assert.equal(evaluateSlip({ ...slip1, receiver_account_tail: "" , receiver_name: "ZIN  MAR  WIN" }, base()).level, "ok");
});

test("without SLIP_RECEIVERS the receiver is shown but not judged", () => {
  const r = evaluateSlip(slip1, base({ receivers: [] }));
  assert.equal(r.level, "ok");
  assert.ok(has(r, "info", /not checked/));
});

test("top-up (no expected amount) just reports the amount", () => {
  const r = evaluateSlip(slip1, base({ expectedAmount: null }));
  assert.equal(r.level, "ok");
  assert.ok(has(r, "info", /Amount on slip: 12,000/));
});

test("not a payment slip / failed payment are problems", () => {
  assert.equal(evaluateSlip({ is_payment_slip: false }, base()).level, "bad");
  assert.equal(evaluateSlip({ ...slip1, status: "failed" }, base()).level, "bad");
});

test("Thai bank slips use Thailand time (UTC+7), not Myanmar time", () => {
  const thai = { ...slip1, provider: "KBank", currency: "THB", transaction_datetime: "2026-10-08T14:00:00" };
  const sevenUtc = Date.UTC(2026, 9, 8, 7, 0, 0); // 14:00 in Thailand
  assert.equal(evaluateSlip(thai, base({ receivers: [], expectedAmount: null, nowMs: sevenUtc + 10 * 60000 })).level, "ok");
  // Read as Myanmar time the same slip would be 30 min in the future.
  const asMyanmar = evaluateSlip({ ...thai, provider: "unknown" }, base({ receivers: [], expectedAmount: null, nowMs: sevenUtc + 10 * 60000 }));
  assert.ok(has(asMyanmar, "ok", /Time/) || has(asMyanmar, "warn", /future/));
});

test("a time in the future is flagged", () => {
  const r = evaluateSlip(slip1, base({ nowMs: slip1Utc - 60 * 60000 }));
  assert.ok(has(r, "warn", /in the future/));
});

test("unreadable pieces warn instead of passing silently", () => {
  const r = evaluateSlip({ is_payment_slip: true, legibility: "partly_unclear" }, base());
  assert.equal(r.level, "warn");
  assert.ok(has(r, "warn", /amount/i));
  assert.ok(has(r, "warn", /transaction number/i));
});

test("helpers", () => {
  assert.deepEqual(parseReceivers("A B|1111; C D|12-34"), [{ name: "A B", tail: "1111" }, { name: "C D", tail: "1234" }]);
  assert.deepEqual(parseReceivers(""), []);
  assert.equal(txnKeyOf(" 0100-42 98 ab "), "010042" + "98AB");
});

const DAY = 86400000;
test("key reminders: quiet when far from expiry, then 14/7/3/1/0 days", () => {
  const now = Date.UTC(2027, 0, 1);
  assert.equal(keyWarning({ expiresAt: now + 30 * DAY, remainingUsd: 4 }, now), null);
  assert.equal(keyWarning({ expiresAt: now + 10 * DAY }, now).key, "exp14");
  assert.equal(keyWarning({ expiresAt: now + 6 * DAY }, now).key, "exp7");
  assert.equal(keyWarning({ expiresAt: now + 2 * DAY }, now).key, "exp3");
  assert.equal(keyWarning({ expiresAt: now + 0.5 * DAY }, now).key, "exp1");
  assert.equal(keyWarning({ expiresAt: now - 1000 }, now).key, "exp0");
});

test("key reminders: low credit", () => {
  assert.equal(keyWarning({ remainingUsd: 0.6 }).key, "low1");
  assert.equal(keyWarning({ remainingUsd: 0.1 }).key, "low025");
  assert.equal(keyWarning({ remainingUsd: 3 }), null);
  assert.equal(keyWarning(null), null);
});

test("which API errors count as a key problem", () => {
  assert.equal(isKeyProblem(401), true);
  assert.equal(isKeyProblem(402), true);
  assert.equal(isKeyProblem(403), true);
  assert.equal(isKeyProblem(400, "Your credit balance is too low"), true);
  assert.equal(isKeyProblem(500, "upstream hiccup"), false);
  assert.equal(isKeyProblem(429, "slow down"), false);
});

// ── Other providers (fields transcribed by hand from real samples) ───────────
// AYA Pay e-receipt: receiver shown as a phone number, 12-hour time.
const aya = {
  is_payment_slip: true, provider: "AYA Pay", status: "success", amount: 9500, currency: "MMK",
  transaction_datetime: "2026-10-10T13:59:00", transaction_id: "100000000001",
  sender_name: "SENDER ONE", receiver_name: "ZIN MAR WIN", receiver_account_tail: "1111",
  legibility: "clear", edit_signs: [],
};
// Wave-style phone photo: name spelled "Zin Mar Wint", 10-digit transaction number.
const wave = {
  is_payment_slip: true, provider: "Wave Money", status: "success", amount: 25000, currency: "MMK",
  transaction_datetime: "2026-09-16T20:27:00", transaction_id: "1000000001",
  receiver_name: "Zin Mar Wint", receiver_account_tail: "1111", legibility: "clear", edit_signs: [],
};
const ayaUtc = Date.UTC(2026, 9, 10, 7, 29, 0); // 13:59 Myanmar = 07:29 UTC

test("AYA Pay slip passes (phone tail + same name)", () => {
  const r = evaluateSlip(aya, base({ expectedAmount: 9500, nowMs: ayaUtc + 15 * 60000 }));
  assert.equal(r.level, "ok");
  assert.ok(has(r, "ok", /your account/));
});

test("Wave spelling 'Tint' still counts as your account", () => {
  const r = evaluateSlip(wave, base({ expectedAmount: 25000, nowMs: Date.UTC(2026, 8, 16, 14, 0, 0) }));
  assert.ok(has(r, "ok", /your account/), JSON.stringify(r.checks));
});

test("same last digits but a different person is only a warning to check", () => {
  const r = evaluateSlip({ ...aya, receiver_name: "KO AUNG KYAW" }, base({ expectedAmount: 9500, nowMs: ayaUtc + 15 * 60000 }));
  assert.ok(has(r, "warn", /name is different/));
  assert.notEqual(r.level, "ok");
});

test("different number is a problem", () => {
  const r = evaluateSlip({ ...aya, receiver_account_tail: "5555" }, base({ expectedAmount: 9500, nowMs: ayaUtc + 15 * 60000 }));
  assert.ok(has(r, "bad", /not one of your accounts/));
});

// ── CB Bank and a Thai bank (Krungthai, paid in baht) ────────────────────────
const MY_ACCOUNTS = parseReceivers("Zin Mar Win|1111;Zin Mar Win|2222;Zin Mar Win|3333");
const cb = {
  is_payment_slip: true, provider: "CB Bank", status: "success", amount: 12000, currency: "MMK",
  transaction_datetime: "2026-09-17T11:48:00", transaction_id: "FT00000AA001",
  sender_name: "SENDER TWO", receiver_name: "DAW ZIN MAR WIN", receiver_account_tail: "2222",
  legibility: "clear", edit_signs: [],
};
const krungthai = {
  is_payment_slip: true, provider: "Krungthai", status: "success", amount: 835, currency: "THB",
  transaction_datetime: "2026-08-10T09:31:00", transaction_id: "Aa00000a0a0a0000a",
  sender_name: "SENDER THREE", receiver_name: "ZIN MAR WIN", receiver_account_tail: "3333",
  legibility: "clear", edit_signs: [],
};

test("CB slip: second account of yours (…2222), 'DAW' title ignored", () => {
  const r = evaluateSlip(cb, base({ receivers: MY_ACCOUNTS, expectedAmount: 12000, nowMs: Date.UTC(2026, 8, 17, 5, 48, 0) }));
  assert.equal(r.level, "ok", JSON.stringify(r.checks));
  assert.equal(r.txnKey, "FT00000AA001");
});

test("the CB account is unknown if you only listed 1111", () => {
  const r = evaluateSlip(cb, base({ expectedAmount: 12000, nowMs: Date.UTC(2026, 8, 17, 5, 48, 0) }));
  assert.ok(has(r, "bad", /not one of your accounts/));
});

test("baht slip with no rate set: warns instead of calling it a mismatch", () => {
  const r = evaluateSlip(krungthai, base({ receivers: MY_ACCOUNTS, expectedAmount: 12000, nowMs: Date.UTC(2026, 7, 10, 3, 0, 0) }));
  assert.ok(has(r, "warn", /Paid in THB/));
  assert.ok(!has(r, "bad", /order is/));
  assert.ok(has(r, "ok", /your account/));
});

test("baht slip with a rate: converted and compared; Thai clock is UTC+7", () => {
  const ctx = base({ receivers: MY_ACCOUNTS, expectedAmount: 12000, nowMs: Date.UTC(2026, 7, 10, 2, 40, 0), thbRate: 14.4, rateTolPct: 3 });
  const r = evaluateSlip(krungthai, ctx); // 09:31 Thai = 02:31 UTC, 9 minutes before "now"
  assert.ok(has(r, "ok", /matches the order/), JSON.stringify(r.checks));
  assert.ok(!has(r, "warn", /Old slip|old/i), JSON.stringify(r.checks));
  const more = evaluateSlip(krungthai, { ...ctx, thbRate: 20 }); // 16,700 MMK vs 12,000: paid MORE
  assert.ok(has(more, "warn", /MORE than the order/));
  const short = evaluateSlip(krungthai, { ...ctx, thbRate: 10 }); // 8,350 MMK vs 12,000: paid LESS
  assert.ok(has(short, "bad", /SHORT/));
});

// ── Slip QR codes (made-up payloads in the real formats) ─────────────────────
import { parseSlipQr, crc16 } from "../slipqr.js";
import { applyQr, fpKeyOf } from "../slipcheck.js";

const kbzQr = (tid, ts) =>
  "KPRSC." + Buffer.from(JSON.stringify({ v: 1, exp: ts + 600000, tid, ts, typ: "R" })).toString("base64url") + ".c2lnbmF0dXJl";
function thaiQr(ref, bank = "006") {
  const inner = "0006000001" + "0103" + bank + "02" + String(ref.length).padStart(2, "0") + ref;
  const body = "00" + String(inner.length).padStart(2, "0") + inner + "5102TH" + "9104";
  return body + crc16(body);
}

test("KBZPay QR gives the exact transaction number and time", () => {
  const ts = Date.UTC(2026, 9, 8, 10, 16, 15);
  const q = parseSlipQr(kbzQr("01000000000000000001", ts));
  assert.deepEqual(q, { kind: "kbzpay", txnId: "01000000000000000001", tsMs: ts });
});

test("Thai slip QR gives the bank's reference; a damaged one is rejected", () => {
  const good = thaiQr("Aa00000a0a0a0000a");
  assert.deepEqual(parseSlipQr(good), { kind: "thai", txnId: "Aa00000a0a0a0000a", tsMs: null, bank: "Krungthai" });
  const damaged = good.slice(0, 20) + "X" + good.slice(21);
  assert.equal(parseSlipQr(damaged), null);
  assert.equal(parseSlipQr("https://example.com"), null);
  assert.equal(parseSlipQr(""), null);
});

test("the QR number replaces a misread one, and says so", () => {
  const misread = { ...slip1, transaction_id: "01000000000000009951" };
  const f = applyQr(misread, { kind: "kbzpay", txnId: "01000000000000005951", tsMs: slip1Utc + 2000 });
  assert.equal(f.transaction_id, "01000000000000005951");
  assert.equal(f.txn_source, "qr");
  const r = evaluateSlip(f, base());
  assert.ok(has(r, "ok", /exact, from the QR/));
  assert.ok(has(r, "info", /QR says/));
});

test("no QR: number is flagged as read from the picture", () => {
  const r = evaluateSlip(applyQr(slip1, null), base());
  assert.ok(has(r, "info", /read from the picture/));
});

test("a printed time that disagrees with the QR time is a problem", () => {
  const edited = applyQr(slip1, { kind: "kbzpay", txnId: slip1.transaction_id, tsMs: slip1Utc - 3 * 3600000 });
  const r = evaluateSlip(edited, base());
  assert.ok(has(r, "bad", /doesn't match the slip's QR/));
  const fine = evaluateSlip(applyQr(slip1, { kind: "kbzpay", txnId: slip1.transaction_id, tsMs: slip1Utc + 2000 }), base());
  assert.ok(!has(fine, "bad", /QR/));
});

test("fingerprint: same amount/time/receiver, different number → warning", () => {
  assert.equal(fpKeyOf(slip1), "FP:1200000:2026-10-08T16:46:1111");
  assert.equal(fpKeyOf({ ...slip1, receiver_account_tail: "" }), "");
  const fpRows = [{ txnId: "01000000000000009999", ref: "ORD-0001", seenAt: "earlier" }];
  const r = evaluateSlip(slip1, base({ fpRows }));
  assert.ok(has(r, "warn", /Same amount, time and receiver as ORD-0001/));
  // the very same slip re-sent for the same order is not a look-alike
  const same = evaluateSlip(slip1, base({ fpRows: [{ txnId: slip1.transaction_id, ref: "ORD-0001" }], ref: "ORD-0001" }));
  assert.ok(!has(same, "warn", /Same amount/));
});

test("day/month swapped by the reader is corrected from the QR time", () => {
  // slip1 is 08/10/2026 16:46:13 Myanmar time; the reader returned 10 August instead.
  const swapped = { ...slip1, transaction_datetime: "2026-08-10T16:46:13" };
  const f = applyQr(swapped, { kind: "kbzpay", txnId: slip1.transaction_id, tsMs: slip1Utc + 2000 });
  assert.equal(f.transaction_datetime, "2026-10-08T16:46:13");
  assert.equal(f.date_fixed, true);
  const r = evaluateSlip(f, base());
  assert.ok(has(r, "info", /Day and month were swapped/));
  assert.ok(!has(r, "warn", /Old slip/));
  // a genuinely different time is not "fixed" — it is flagged
  const edited = applyQr({ ...slip1, transaction_datetime: "2026-10-08T12:00:00" }, { kind: "kbzpay", txnId: slip1.transaction_id, tsMs: slip1Utc });
  assert.equal(edited.date_fixed, undefined);
});

test("a short or wrong-length transaction number read from the picture is flagged", () => {
  const short = evaluateSlip(applyQr({ ...slip1, transaction_id: "451" }, null), base());
  assert.ok(has(short, "warn", /20 digits but this reads 3/));
  const ok20 = evaluateSlip(applyQr(slip1, null), base());
  assert.ok(!has(ok20, "warn", /20 digits/));
  const other = evaluateSlip(applyQr({ ...slip1, provider: "AYA Pay", transaction_id: "12345" }, null), base());
  assert.ok(has(other, "warn", /too short/));
});

test("providers: official key first, SLIP_API_KEY is the backup", () => {
  const p = slipProviders({ ANTHROPIC_API_KEY: "sk-ant-x", SLIP_API_KEY: "sk-orynx-y", SLIP_API_BASE_URL: "https://api.orynx.dev/", SLIP_MODEL: "claude-haiku-4-5", SLIP_MODEL_OFFICIAL: "claude-haiku-5-5", ANTHROPIC_KEY_EXPIRES: "2027-10-01", SLIP_KEY_EXPIRES: "2027-01-08" });
  assert.equal(p.length, 2);
  assert.equal(p[0].baseUrl, "https://api.anthropic.com");
  assert.equal(p[0].model, "claude-haiku-5-5");
  assert.equal(p[0].expires, "2027-10-01");
  assert.equal(p[1].baseUrl, "https://api.orynx.dev");
  assert.equal(p[1].model, "claude-haiku-4-5");
  assert.equal(p[1].expires, "2027-01-08");
});

test("providers: single key behaves as before", () => {
  const only = slipProviders({ SLIP_API_KEY: "sk-orynx-y", SLIP_API_BASE_URL: "https://api.orynx.dev", SLIP_KEY_EXPIRES: "2027-01-08" });
  assert.equal(only.length, 1);
  assert.equal(only[0].expires, "2027-01-08");
  const ant = slipProviders({ ANTHROPIC_API_KEY: "sk-ant-x", SLIP_KEY_EXPIRES: "2027-10-01" });
  assert.equal(ant.length, 1);
  assert.equal(ant[0].expires, "2027-10-01");
  assert.equal(slipProviders({}).length, 0);
});

test("a reading is complete only with amount, time, receiver tail and txn number", () => {
  const full = { is_payment_slip: true, amount: 100, transaction_datetime: "2026-10-11T10:00:00", receiver_account_tail: "9141", transaction_id: "123" };
  assert.equal(slipIsComplete(full), true);
  assert.equal(slipIsComplete({ ...full, transaction_id: "" }), false);
  assert.equal(slipIsComplete({ ...full, transaction_datetime: undefined }), false);
  assert.equal(slipIsComplete({ is_payment_slip: false }), true);
});

test("Burmese digits are converted exactly, in code", () => {
  assert.equal(parseBurmeseAmount("၆,၅၀၀.၀၀"), 6500);
  assert.equal(parseBurmeseAmount("၂၅,၀၀၀.၀၀ ကျပ်"), 25000);
  assert.equal(parseBurmeseDateTime("၁၈ မေ ၂၀၂၆ • ၇:၅၅ ညနေ"), "2026-05-18T19:55:00");
  assert.equal(parseBurmeseDateTime("၀၅ မတ် ၂၀၂၆ • ၆:၂၂ ညနေ"), "2026-03-05T18:22:00");
  assert.equal(parseBurmeseDateTime("၂၉ ဒီဇင်ဘာ ၂၀၂၆ • ၉:၀၅ နံနက်"), "2026-12-29T09:05:00");
  assert.equal(parseBurmeseDateTime("garbled"), null);
});

test("the model's own Burmese conversion is replaced by the exact one", () => {
  const f = normalizeBurmese({ amount: 9900, amount_as_printed: "၆,၅၀၀.၀၀", transaction_datetime: "2024-12-06T18:27:00", datetime_as_printed: "၀၅ မတ် ၂၀၂၆ • ၆:၂၂ ညနေ" });
  assert.equal(f.amount, 6500);
  assert.equal(f.transaction_datetime, "2026-03-05T18:22:00");
  assert.deepEqual(f.unsure, []);
});

test("two readings must agree; disagreement is dropped and flagged", () => {
  const a = { provider: "Wave Money", legibility: "clear", amount: 6500, transaction_datetime: "2026-03-05T18:22:00", receiver_account_tail: "9141", transaction_id: "1064691145" };
  const same = reconcile(a, { ...a, transaction_datetime: "2026-03-05T18:22:30" });
  assert.equal(same.unsure.length, 0);
  assert.equal(same.legibility, "clear");
  const diff = reconcile(a, { ...a, amount: 9900, transaction_id: "1064691146" });
  assert.deepEqual(diff.unsure, ["amount", "transaction number"]);
  assert.equal(diff.amount, null);
  assert.equal(diff.transaction_id, undefined);
  assert.equal(diff.legibility, "partly_unclear");
  const filled = reconcile({ ...a, transaction_id: "" }, a);
  assert.equal(filled.transaction_id, "1064691145");
});

test("only Wave / Burmese-digit slips without a QR get a second opinion", () => {
  assert.equal(needsSecondOpinion({ provider: "Wave Money" }, null), true);
  assert.equal(needsSecondOpinion({ provider: "KBZPay", amount_as_printed: "12,000.00" }, { txnId: "x" }), false);
  assert.equal(needsSecondOpinion({ provider: "KBZPay", amount_as_printed: "12,000.00" }, null), false);
  assert.equal(needsSecondOpinion({ provider: "KBZPay", digits_script: "burmese" }, null), true);
});

test("Burmese digits on a picture never come out green", () => {
  const r = evaluateSlip({ ...slip1, digits_script: "burmese", txn_source: "image" }, base());
  assert.notEqual(r.level, "ok");
  assert.ok(r.checks.some((c) => /Burmese digits/.test(c.text)));
});
