/**
 * Expiry audit + backfill.
 *
 *   node expiry-tool.mjs            → report only, changes nothing
 *   node expiry-tool.mjs --write    → also fill in missing Expiry Date cells
 *
 * The report answers two questions:
 *   1. Which product Duration values can't be parsed? Those silently produce
 *      no expiry date, so every renewal report would miss those customers.
 *   2. Which already-delivered orders have no expiry yet? Everything sold
 *      before this feature existed, which is most of your history.
 *
 * Always run without --write first and read the output. The backfill uses the
 * delivery timestamp already in the sheet, so it reproduces exactly what the
 * bot would have written at the time.
 */
import "dotenv/config";
import { google } from "googleapis";
import { parseDuration, expiryFor, ensureOrderExpiryColumn } from "./sheets.js";

const WRITE = process.argv.includes("--write");
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

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

const get = async (range) =>
  (await sheets.spreadsheets.values.get({ spreadsheetId, range })).data.values || [];

console.log(WRITE ? "MODE: write\n" : "MODE: report only (pass --write to apply)\n");

// ── 1. Product durations ─────────────────────────────────────────────────────
const products = await get("Products!A1:Z");
const headers = (products[0] || []).map((h) => String(h || "").trim().toLowerCase());
const iName = headers.indexOf("product name");
const iVariant = headers.indexOf("variant");
const iDuration = headers.indexOf("duration");

console.log("── Product durations ──");
if (iDuration === -1) {
  console.log("  No Duration column found in Products.\n");
} else {
  const bad = [];
  let ok = 0;
  for (const row of products.slice(1)) {
    const name = String(row[iName] || "").trim();
    if (!name) continue;
    const raw = String(row[iDuration] || "").trim();
    if (parseDuration(raw)) ok++;
    else bad.push(`${name}${row[iVariant] ? ` — ${row[iVariant]}` : ""}: ${raw || "(blank)"}`);
  }
  console.log(`  ${ok} parsed cleanly`);
  if (bad.length) {
    console.log(`  ${bad.length} could NOT be parsed — these will get no expiry date:`);
    for (const b of bad) console.log(`    • ${b}`);
    console.log("    Fix by writing them like: 1 Month · 6 Month · 1 Year · 30 Days");
  }
  console.log("");
}

// Product ID → duration text, for the order backfill below.
const iId = headers.indexOf("product id");
const durationById = new Map();
for (const row of products.slice(1)) {
  const id = String(row[iId] || "").trim();
  if (id) durationById.set(id, String(row[iDuration] || "").trim());
}

// ── 2. Orders missing an expiry ──────────────────────────────────────────────
await ensureOrderExpiryColumn();
const orders = await get("Orders!A2:R");

const fixes = [];
let alreadySet = 0;
let noDuration = 0;
let noDeliveryTime = 0;

orders.forEach((r, i) => {
  const rowNumber = i + 2;
  const orderId = String(r[0] || "").trim();
  if (!orderId) return;

  if (String(r[17] || "").trim()) return void alreadySet++;

  const productId = String(r[4] || "").trim();
  // Delivery time (P) is when the clock starts; fall back to decision time (L)
  // and finally the created date (B) for older rows that predate those fields.
  const start = String(r[15] || r[11] || r[1] || "").trim();
  if (!start) return void noDeliveryTime++;

  const duration = durationById.get(productId);
  const expiry = expiryFor(start, duration);
  if (!expiry) return void noDuration++;

  fixes.push({ rowNumber, orderId, start, duration, expiry });
});

console.log("── Orders ──");
console.log(`  ${orders.length} rows`);
console.log(`  ${alreadySet} already have an expiry`);
console.log(`  ${fixes.length} can be filled in`);
if (noDuration) console.log(`  ${noDuration} skipped — product duration missing/unparseable`);
if (noDeliveryTime) console.log(`  ${noDeliveryTime} skipped — no usable date on the row`);
console.log("");

if (fixes.length) {
  console.log("  First 10 to be written:");
  for (const f of fixes.slice(0, 10)) {
    console.log(`    ${f.orderId}  ${f.start}  + ${f.duration}  →  ${f.expiry}`);
  }
  if (fixes.length > 10) console.log(`    … and ${fixes.length - 10} more`);
  console.log("");
}

if (!WRITE) {
  console.log(fixes.length ? "Run again with --write to apply." : "Nothing to do.");
  process.exit(0);
}

if (fixes.length === 0) {
  console.log("Nothing to write.");
  process.exit(0);
}

// Batch the updates so this is a couple of API calls, not one per row.
const BATCH = 200;
for (let i = 0; i < fixes.length; i += BATCH) {
  const chunk = fixes.slice(i, i + BATCH);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: chunk.map((f) => ({ range: `Orders!R${f.rowNumber}`, values: [[f.expiry]] })),
    },
  });
  console.log(`  wrote ${Math.min(i + BATCH, fixes.length)} / ${fixes.length}`);
}
console.log("\n✔ Backfill complete.");
