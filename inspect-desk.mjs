/**
 * Check whether the bot can reach the Order Desk sheet, and print its schema.
 *
 *   node inspect-desk.mjs
 *
 * Two things at once:
 *   1. Confirms the service account has been shared into the Desk sheet. If it
 *      hasn't, you get a clear message instead of a cryptic 403 later.
 *   2. Prints every tab and its header row, so the bot's rows can be written in
 *      exactly the shape the Apps Script already expects.
 *
 * Reads nothing but headers and a couple of sample rows — no customer data is
 * printed beyond what's needed to see the column layout.
 */
import "dotenv/config";
import { google } from "googleapis";

const DESK_ID =
  process.env.DESK_SHEET_ID ||
  process.argv[2] ||
  "1NW6CtFW46zv_NnClS1ENzmpdEkjuH-oYD1olU92sgeI";

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

console.log(`Service account: ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
console.log(`Desk sheet:      ${DESK_ID}\n`);

let meta;
try {
  meta = await sheets.spreadsheets.get({
    spreadsheetId: DESK_ID,
    fields: "properties.title,sheets.properties.title",
  });
} catch (e) {
  const msg = String(e.message || e);
  console.error("❌ Could not open the Desk sheet.\n");
  if (/permission|403/i.test(msg)) {
    console.error("   The service account has not been shared in yet.");
    console.error("   Open the Desk sheet → Share → add this address as Editor:\n");
    console.error(`     ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}\n`);
    console.error("   It's a robot account — no invitation email is sent, it just gains access.");
  } else if (/not found|404/i.test(msg)) {
    console.error("   That spreadsheet id doesn't exist or isn't visible.");
  } else {
    console.error(`   ${msg}`);
  }
  process.exit(1);
}

console.log(`✔ Access OK — "${meta.data.properties.title}"\n`);

const tabs = (meta.data.sheets || []).map((s) => s.properties.title);
console.log(`Tabs: ${tabs.join(" · ")}\n`);

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

for (const tab of tabs) {
  console.log("─".repeat(70));
  console.log(`TAB: ${tab}`);
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: DESK_ID,
      range: `'${tab}'!A1:BZ3`,
    });
    const rows = res.data.values || [];
    const headers = rows[0] || [];
    if (headers.length === 0) {
      console.log("  (empty)");
      continue;
    }
    headers.forEach((h, i) => {
      const sample = (rows[1] || [])[i];
      console.log(
        `  ${colLetter(i).padEnd(3)} ${String(h || "(blank)").padEnd(26)}` +
          (sample ? ` e.g. ${String(sample).slice(0, 30)}` : "")
      );
    });
  } catch (e) {
    console.log(`  could not read: ${e.message}`);
  }
}
console.log("─".repeat(70));
console.log("\nPaste this whole output back into the chat.");
