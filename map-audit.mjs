/**
 * Compare the bot's catalogue against the Order Desk's vocabulary.
 *
 *   node map-audit.mjs
 *
 * The Desk drives Renewals, Reports and price lookups off exact string
 * matches — Item must be one of its Config values, Duration must be one of
 * its Duration values. A row with "Capcut Pro" where the Desk expects
 * "Capcut" still appears in the sheet but silently drops out of every report.
 *
 * So before wiring the bot to write there, this prints exactly which values
 * line up and which don't. Read-only; changes nothing.
 */
import "dotenv/config";
import { google } from "googleapis";

const BOT_ID = process.env.GOOGLE_SHEET_ID;
const DESK_ID = process.env.DESK_SHEET_ID || "1NW6CtFW46zv_NnClS1ENzmpdEkjuH-oYD1olU92sgeI";

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || "")
      .replace(/^["']|["']$/g, "")
      .replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const get = async (id, range) =>
  (await sheets.spreadsheets.values.get({ spreadsheetId: id, range })).data.values || [];

/** Loose key for comparison: case and spacing shouldn't decide a match. */
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "").trim();

// ── Desk vocabulary ──────────────────────────────────────────────────────────
const config = await get(DESK_ID, "Config!A2:G");
const lists = {};
for (const r of config) {
  const list = String(r[0] || "").trim();
  const value = String(r[1] || "").trim();
  const active = String(r[4] || "").trim().toUpperCase();
  if (!list || !value || active === "FALSE") continue;
  (lists[list] ||= []).push({
    value,
    needsEmail: String(r[2] || "").toUpperCase() === "TRUE",
    reminder: String(r[5] || "").toUpperCase() === "TRUE",
    track: String(r[6] || "").toUpperCase() === "TRUE",
  });
}

console.log("═══ Desk vocabulary (Config tab) ═══\n");
for (const [name, values] of Object.entries(lists)) {
  console.log(`${name}: ${values.map((v) => v.value).join(" · ")}`);
}

const reminderItems = (lists.Item || []).filter((v) => v.reminder).map((v) => v.value);
const trackItems = (lists.Item || []).filter((v) => v.track).map((v) => v.value);
const emailItems = (lists.Item || []).filter((v) => v.needsEmail).map((v) => v.value);
console.log(`\n  auto 14-day reminder : ${reminderItems.join(", ") || "(none)"}`);
console.log(`  tracked for renewal  : ${trackItems.join(", ") || "(none)"}`);
console.log(`  needs email          : ${emailItems.join(", ") || "(none)"}`);

// ── Bot catalogue ────────────────────────────────────────────────────────────
const products = await get(BOT_ID, "Products!A1:Z");
const h = (products[0] || []).map((x) => String(x || "").trim().toLowerCase());
const col = (...names) => {
  for (const n of names) {
    const i = h.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
};
const iName = col("product name", "name");
const iVariant = col("variant");
const iDuration = col("duration");
const iPrice = col("price (mmk)", "price");
const iActive = col("active");

const deskItems = new Set((lists.Item || []).map((v) => norm(v.value)));
const deskDurations = new Set((lists.Duration || []).map((v) => norm(v.value)));
const deskAccess = new Set((lists["Share/Private"] || lists.Access || []).map((v) => norm(v.value)));

const rows = products.slice(1).filter((r) => String(r[iName] || "").trim());
const itemMisses = new Map();
const durationMisses = new Map();
const accessMisses = new Map();

for (const r of rows) {
  if (String(r[iActive] || "").trim().toLowerCase() === "no") continue;
  const name = String(r[iName] || "").trim();
  const variant = String(r[iVariant] || "").trim();
  const duration = String(r[iDuration] || "").trim();

  if (!deskItems.has(norm(name))) itemMisses.set(name, (itemMisses.get(name) || 0) + 1);
  if (duration && !deskDurations.has(norm(duration)))
    durationMisses.set(duration, (durationMisses.get(duration) || 0) + 1);

  // Variant is free text on the bot ("Private Acc (6Month)"); the Desk wants
  // exactly Share / Private / Own.
  if (variant && deskAccess.size) {
    const hit = [...deskAccess].some((a) => norm(variant).includes(a));
    if (!hit) accessMisses.set(variant, (accessMisses.get(variant) || 0) + 1);
  }
}

const report = (title, map, fix) => {
  console.log(`\n── ${title} ──`);
  if (map.size === 0) return console.log("  ✔ all values match the Desk");
  console.log(`  ✗ ${map.size} value(s) the Desk will not recognise:`);
  for (const [v, n] of [...map].sort((a, b) => b[1] - a[1])) {
    console.log(`      "${v}"  (${n} product row${n > 1 ? "s" : ""})`);
  }
  console.log(`    → ${fix}`);
};

console.log("\n\n═══ Bot catalogue vs Desk ═══");
console.log(`\n${rows.length} active product rows checked`);
report("Item names", itemMisses, "add these to the Desk's Config Item list, or map them in the bot");
report("Durations", durationMisses, "match the Desk's spelling exactly, e.g. 1Month not '1 Month'");
report("Access / variant", accessMisses, "the Desk wants Share, Private or Own");

// ── Price comparison ─────────────────────────────────────────────────────────
const prices = await get(DESK_ID, "Prices!A2:D");
const deskPrice = new Map();
for (const r of prices) {
  const key = [norm(r[0]), norm(r[1]), norm(r[2])].join("|");
  deskPrice.set(key, Number(String(r[3] || "").replace(/[^\d.]/g, "")) || 0);
}

console.log("\n── Prices ──");
let compared = 0;
const diffs = [];
for (const r of rows) {
  const name = String(r[iName] || "").trim();
  const variant = String(r[iVariant] || "").trim();
  const duration = String(r[iDuration] || "").trim();
  const botPrice = Number(String(r[iPrice] || "").replace(/[^\d.]/g, "")) || 0;
  const access = ["share", "private", "own"].find((a) => norm(variant).includes(a));
  if (!access || !duration) continue;

  const key = [norm(name), access, norm(duration)].join("|");
  if (!deskPrice.has(key)) continue;
  compared++;
  const dp = deskPrice.get(key);
  if (dp !== botPrice) diffs.push({ name, variant, duration, botPrice, dp });
}
if (compared === 0) {
  console.log("  no rows could be compared — item/duration names differ too much");
} else if (diffs.length === 0) {
  console.log(`  ✔ ${compared} matched rows all agree on price`);
} else {
  console.log(`  ✗ ${diffs.length} of ${compared} matched rows disagree:`);
  for (const d of diffs) {
    console.log(`      ${d.name} ${d.variant} ${d.duration}: bot ${d.botPrice} vs desk ${d.dp}`);
  }
  console.log("    → decide which sheet is authoritative for pricing");
}

console.log("\nPaste this output back into the chat.");
