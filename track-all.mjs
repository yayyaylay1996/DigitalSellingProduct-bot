/**
 * Turn Track on for every item in the Desk's Config list.
 *
 *   node track-all.mjs           → preview
 *   node track-all.mjs --write   → apply
 *
 * Track is what puts a sale on the Renewals list. Every product sold here is
 * a subscription that eventually lapses, so every product should be tracked —
 * an untracked item means a customer who quietly disappears at expiry.
 *
 * Deliberately does NOT touch the Reminder column: that's the 14-day calendar
 * chase, which is only wanted for Zoom.
 */
import "dotenv/config";
import { google } from "googleapis";

const WRITE = process.argv.includes("--write");
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

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: DESK_ID,
  range: "Config!A2:G",
});
const rows = res.data.values || [];

const items = [];
rows.forEach((r, i) => {
  if (String(r[0] || "").trim() !== "Item") return;
  const value = String(r[1] || "").trim();
  if (!value) return;
  items.push({
    row: i + 2,
    value,
    track: String(r[6] || "").trim().toUpperCase() === "TRUE",
    reminder: String(r[5] || "").trim().toUpperCase() === "TRUE",
  });
});

const off = items.filter((i) => !i.track);

console.log(WRITE ? "MODE: write\n" : "MODE: preview (add --write to apply)\n");
console.log(`${items.length} items in Config`);
console.log(`  ${items.length - off.length} already tracked`);
console.log(`  ${off.length} to turn on`);
for (const i of off) console.log(`    + ${i.value}`);

console.log("\n14-day reminder is on for (should be Zoom only):");
const rem = items.filter((i) => i.reminder);
for (const i of rem) console.log(`    ${i.value}`);
const strays = rem.filter((i) => !/zoom/i.test(i.value));
if (strays.length) {
  console.log(`  ⚠️ ${strays.length} non-Zoom item(s) have the reminder flag:`);
  for (const s of strays) console.log(`      ${s.value} — turn Config column F to FALSE`);
}

if (!WRITE) {
  console.log(off.length ? "\nRun again with --write to apply." : "\nNothing to do.");
  process.exit(0);
}
if (off.length === 0) {
  console.log("\nNothing to write.");
  process.exit(0);
}

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: DESK_ID,
  requestBody: {
    valueInputOption: "USER_ENTERED",
    data: off.map((i) => ({ range: `Config!G${i.row}`, values: [["TRUE"]] })),
  },
});
console.log(`\n✔ Track turned on for ${off.length} item(s)`);
