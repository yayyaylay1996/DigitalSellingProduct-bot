// Run with:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { parseStaffList, isStaff, isApprover, parseCaptionAmount, formatVerdict, approvalRows, confirmRows, parseApproval, decisionText, rolesOf, adminIdLooksWrong, MSG } from "../staff-bot-lib.js";

test("staff list: ids and usernames, any separator, @ and case ignored", () => {
  const l = parseStaffList("111, @Mg_Mg 222;ma_ma\n333");
  assert.deepEqual([...l.ids].sort(), ["111", "222", "333"]);
  assert.deepEqual([...l.names].sort(), ["ma_ma", "mg_mg"]);
});

test("isStaff: listed id, listed username, admin, and strangers", () => {
  const l = parseStaffList("111,@mg_mg");
  assert.equal(isStaff({ id: 111 }, l), true);
  assert.equal(isStaff({ id: 5, username: "Mg_Mg" }, l), true);
  assert.equal(isStaff({ id: 999 }, l, "999"), true);
  assert.equal(isStaff({ id: 5, username: "other" }, l), false);
  assert.equal(isStaff({ id: 5 }, parseStaffList(""), ""), false);
  assert.equal(isStaff(undefined, l), false);
});

test("caption amount: plain, commas, units, Burmese digits", () => {
  assert.equal(parseCaptionAmount("95000").amount, 95000);
  assert.equal(parseCaptionAmount("95,000 ks").amount, 95000);
  assert.equal(parseCaptionAmount("ks 1,250,000").amount, 1250000);
  assert.equal(parseCaptionAmount("၉၅,၀၀၀").amount, 95000);
  assert.equal(parseCaptionAmount("95000 95000").amount, 95000); // same number twice is fine
  assert.equal(parseCaptionAmount("@GF_slip_bot2 95000").amount, 95000); // digits in a @mention are not the amount
  assert.deepEqual(parseCaptionAmount("@slip_bot2"), { amount: null, ambiguous: false });
});

test("caption amount: none, zero, and ambiguous captions", () => {
  assert.deepEqual(parseCaptionAmount(""), { amount: null, ambiguous: false });
  assert.deepEqual(parseCaptionAmount(undefined), { amount: null, ambiguous: false });
  assert.deepEqual(parseCaptionAmount("Netflix"), { amount: null, ambiguous: false });
  assert.deepEqual(parseCaptionAmount("0"), { amount: null, ambiguous: false });
  assert.deepEqual(parseCaptionAmount("order 123 95000"), { amount: null, ambiguous: true });
});

test("formatVerdict: header per level, detail kept, footer always, null = disabled", () => {
  const ok = formatVerdict({ level: "ok", html: "DETAIL" });
  assert.ok(ok.startsWith("🟢"));
  assert.ok(ok.includes("DETAIL"));
  assert.ok(ok.includes(MSG.footer));
  assert.ok(formatVerdict({ level: "bad", html: "x" }).startsWith("🔴"));
  assert.ok(formatVerdict({ level: "warn", html: "x" }).startsWith("🟡"));
  assert.ok(formatVerdict({ level: "mystery", html: "x" }).startsWith("⚠️")); // unknown level never looks green
  assert.ok(formatVerdict({ level: "ok", html: "x" }, { hasAmount: false }).includes(MSG.noAmountNote));
  assert.ok(!formatVerdict({ level: "ok", html: "x" }, { hasAmount: true }).includes(MSG.noAmountNote));
  assert.equal(formatVerdict(null), MSG.disabled);
});

test("roles: sender-only, approver-only and admin are separate", () => {
  const senders = parseStaffList("111");
  const approvers = parseStaffList("222");
  const admin = "999";
  const staffUser = { id: 111 }, supervisor = { id: 222 }, boss = { id: 999 };
  assert.equal(isStaff(staffUser, senders, admin), true);
  assert.equal(isApprover(staffUser, approvers, admin), false);
  assert.equal(isStaff(supervisor, senders, admin), false); // approver cannot send slips
  assert.equal(isApprover(supervisor, approvers, admin), true);
  assert.equal(isStaff(boss, senders, admin), true); // admin does both
  assert.equal(isApprover(boss, approvers, admin), true);
});

test("approval buttons: green one tap, red needs a confirming tap", () => {
  const flat = (rows) => rows.flat().map((b) => b.callback_data);
  assert.deepEqual(flat(approvalRows("ok")), ["ap:ok:ok", "ap:no:ok"]);
  assert.deepEqual(flat(approvalRows("warn")), ["ap:ok:warn", "ap:no:warn"]);
  assert.deepEqual(flat(approvalRows("error")), ["ap:ok:error", "ap:no:error"]);
  // red: "no" leads and there is no direct approve button
  assert.deepEqual(flat(approvalRows("bad")), ["ap:no:bad", "ap:ask:bad"]);
  assert.deepEqual(flat(confirmRows("bad")), ["ap:ok:bad", "ap:back:bad"]);
  assert.equal(approvalRows("mystery")[0][0].callback_data, "ap:ok:error"); // unknown level never looks green
  for (const b of [...approvalRows("ok").flat(), ...confirmRows("bad").flat()]) assert.ok(b.callback_data.length <= 64);
});

test("parseApproval accepts only our own callbacks", () => {
  assert.deepEqual(parseApproval("ap:ok:warn"), { action: "ok", level: "warn" });
  assert.deepEqual(parseApproval("ap:back:bad"), { action: "back", level: "bad" });
  for (const bad of ["verify:ORD-1", "ap:ok", "ap:hack:ok", "ap:ok:green", "", undefined, null]) assert.equal(parseApproval(bad), null);
});

test("decisionText: approved, rejected, approved despite red; names are escaped", () => {
  assert.ok(decisionText("ok", "ok", "@sup", "17:35").startsWith("✅"));
  assert.ok(decisionText("no", "warn", "@sup", "17:35").startsWith("❌"));
  assert.ok(decisionText("ok", "bad", "@sup", "17:35").startsWith("⚠️")); // red approved is flagged as such
  assert.ok(decisionText("ok", "ok", "<b>x</b> & y", "t").includes("&lt;b&gt;x&lt;/b&gt; &amp; y"));
});

test("rolesOf: what /myid reports", () => {
  const senders = parseStaffList("111"), approversL = parseStaffList("222");
  assert.deepEqual(rolesOf({ id: 111 }, senders, approversL, "999"), { send: true, approve: false });
  assert.deepEqual(rolesOf({ id: 222 }, senders, approversL, "999"), { send: false, approve: true });
  assert.deepEqual(rolesOf({ id: 999 }, senders, approversL, "999"), { send: true, approve: true });
  assert.deepEqual(rolesOf({ id: 5 }, senders, approversL, "999"), { send: false, approve: false });
  assert.ok(MSG.myId(5, "x", { send: false, approve: true }).includes("<code>5</code>"));
});

test("a list in ADMIN_CHAT_ID is flagged, and really matches nobody", () => {
  assert.equal(adminIdLooksWrong("1234567890"), false);
  assert.equal(adminIdLooksWrong(""), false);
  assert.equal(adminIdLooksWrong("1234567890,2234567890"), true);
  assert.equal(adminIdLooksWrong("1234567890 2234567890"), true);
  // the reason it matters: the exact-match rule fails for both people in the list
  const none = parseStaffList("");
  assert.equal(isStaff({ id: 1234567890 }, none, "1234567890,2234567890"), false);
  assert.equal(isApprover({ id: 2234567890 }, none, "1234567890,2234567890"), false);
});
