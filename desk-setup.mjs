/**
 * One-time setup so the bot and the Order Desk speak the same language.
 *
 *   node desk-setup.mjs           → show what would change, change nothing
 *   node desk-setup.mjs --write   → apply it
 *
 * Three jobs:
 *   1. Add the products the Desk has never heard of to its Config Item list.
 *   2. Turn the 14-day reminder on for every Zoom item (only Zoom Owner had it).
 *   3. Add a "Desk Item" column to the bot's Products sheet and pre-fill it,
 *      so the bot knows what each product is called on the Desk side.
 *
 * The mapping deliberately lives in your sheet, not in code: when you add a
 * product later you fill in one cell instead of asking for a code change. A
 * blank Desk Item means "don't send this product to the Desk", which is the
 * safe default — no row is better than a row that drops out of every report.
 */
import "dotenv/config";
import { google } from "googleapis";

const WRITE = process.argv.includes("--write");
const BOT_ID = process.env.GOOGLE_SHEET_ID;
const DESK_ID = process.env.DESK_SHEET_ID || "1NW6CtFW46zv_NnClS1ENzmpdEkjuH-oYD1olU92sgeI";

// Bot product name → Desk Config item name. Only the ones that differ.
const ALIASES = {
  "capcut pro": "Capcut",
  "telegram premium": "Telegram",
  "youtube premium": "Youtube",
  "quillbot premium": "Quillbot",
  gemini: "Gemini Pro",
  "claude ai": "Claude",
  // Your Desk has three Zoom items and the bot has one. Best guess below —
  // CHECK THIS CELL in the sheet afterwards and change it if it's wrong.
  "zoom pro": "Zoom Member",
};

// Products the Desk doesn't know yet. Track on (they're subscriptions),
// reminder off (only Zoom needs the 14-day chase), no email needed.
const NEW_ITEMS = [
  "Amazon Prime",
  "Windscribe VPN",
  "Elsa Speak Pro",
  "Meitu (SVIP)",
  "Express VPN - Phone",
  "Perplexity Pro",
];

const ZOOM_ITEMS = ["Zoom Member", "Zoom Owner", "Zoom Private"];

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
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

console.log(WRITE ? "MODE: write\n" : "MODE: preview (add --write to apply)\n");

// ── 1 & 2. Desk Config ───────────────────────────────────────────────────────
const config = await get(DESK_ID, "Config!A2:G");
const existingItems = new Set(
  config.filter((r) => String(r[0] || "").trim() === "Item").map((r) => norm(r[1]))
);

const toAdd = NEW_ITEMS.filter((n) => !existingItems.has(norm(n)));
console.log("── Config: new items ──");
if (toAdd.length === 0) console.log("  nothing to add");
for (const n of toAdd) console.log(`  + ${n}   (Track on, Reminder off)`);

const zoomFixes = [];
config.forEach((r, i) => {
  if (String(r[0] || "").trim() !== "Item") return;
  const value = String(r[1] || "").trim();
  if (!ZOOM_ITEMS.some((z) => norm(z) === norm(value))) return;
  if (String(r[5] || "").toUpperCase() === "TRUE") return; // reminder already on
  zoomFixes.push({ row: i + 2, value });
});

console.log("\n── Config: 14-day reminder for Zoom ──");
if (zoomFixes.length === 0) console.log("  every Zoom item already has it");
for (const z of zoomFixes) console.log(`  ✓ turn on for ${z.value} (row ${z.row})`);

// ── 3. Bot Products → Desk Item column ───────────────────────────────────────
const products = await get(BOT_ID, "Products!A1:Z");
const headers = (products[0] || []).map((h) => String(h || "").trim());
const lower = headers.map((h) => h.toLowerCase());
const iName = lower.indexOf("product name") !== -1 ? lower.indexOf("product name") : lower.indexOf("name");

let iDeskItem = lower.indexOf("desk item");
const isNewColumn = iDeskItem === -1;
if (isNewColumn) iDeskItem = headers.length;

const colLetter = (n) => {
  let s = "";
  n++;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
const deskCol = colLetter(iDeskItem);

// Everything the Desk will know once the additions above are applied.
const deskItemsAfter = new Set([...existingItems, ...toAdd.map(norm)]);

const rowUpdates = [];
const unmapped = [];
products.slice(1).forEach((r, i) => {
  const rowNumber = i + 2;
  const name = String(r[iName] || "").trim();
  if (!name) return;
  if (String(r[iDeskItem] || "").trim()) return; // already mapped, leave alone

  const alias = ALIASES[norm(name)];
  const target = alias || (deskItemsAfter.has(norm(name)) ? name : "");
  if (!target) return void unmapped.push(name);
  rowUpdates.push({ rowNumber, name, target });
});

console.log(`\n── Products: "Desk Item" column (${deskCol})${isNewColumn ? " — will be created" : ""} ──`);
console.log(`  ${rowUpdates.length} rows to fill in`);
const shown = new Map();
for (const u of rowUpdates) if (!shown.has(u.name)) shown.set(u.name, u.target);
for (const [from, to] of shown) console.log(`    ${from}  →  ${to}${from === to ? "" : "   (renamed)"}`);
if (unmapped.length) {
  console.log(`  ${new Set(unmapped).size} left blank (won't sync until you fill them):`);
  for (const n of new Set(unmapped)) console.log(`    ${n}`);
}

if (!WRITE) {
  console.log("\nRun again with --write to apply.");
  process.exit(0);
}

// ── apply ────────────────────────────────────────────────────────────────────
if (toAdd.length) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: DESK_ID,
    range: "Config!A:G",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: toAdd.map((n) => ["Item", n, "FALSE", "FALSE", "TRUE", "FALSE", "TRUE"]),
    },
  });
  console.log(`✔ added ${toAdd.length} items to Config`);
}

if (zoomFixes.length) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: DESK_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: zoomFixes.map((z) => ({ range: `Config!F${z.row}`, values: [["TRUE"]] })),
    },
  });
  console.log(`✔ 14-day reminder enabled for ${zoomFixes.length} Zoom item(s)`);
}

if (isNewColumn) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: BOT_ID,
    range: `Products!${deskCol}1`,
    valueInputOption: "RAW",
    requestBody: { values: [["Desk Item"]] },
  });
  console.log(`✔ created Products!${deskCol}1 "Desk Item"`);
}

if (rowUpdates.length) {
  const BATCH = 200;
  for (let i = 0; i < rowUpdates.length; i += BATCH) {
    const chunk = rowUpdates.slice(i, i + BATCH);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: BOT_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: chunk.map((u) => ({
          range: `Products!${deskCol}${u.rowNumber}`,
          values: [[u.target]],
        })),
      },
    });
  }
  console.log(`✔ filled ${rowUpdates.length} Desk Item cells`);
}

console.log("\nDone. Check the Zoom Pro mapping in the Desk Item column — that one is a guess.");
