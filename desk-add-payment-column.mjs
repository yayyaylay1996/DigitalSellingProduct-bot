// Adds the "Payment" column (U) to the Order Desk's Orders tab.
//
//   node desk-add-payment-column.mjs           # preview only — changes nothing
//   node desk-add-payment-column.mjs --write   # puts the word "Payment" in Orders!U1
//
// The staff bot writes "KPay · S-8F3K" there: how the order was paid + the basket
// reference (the same reference is in the Slips tab). Until U1 says "Payment" the
// bot still works — it just leaves that column out.
import "dotenv/config";
import { google } from "googleapis";

const id = process.env.DESK_SHEET_ID;
if (!id) { console.error("DESK_SHEET_ID is not set (.env)."); process.exit(1); }

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/^["']|["']$/g, "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const head = (await sheets.spreadsheets.values.get({ spreadsheetId: id, range: "Orders!A1:Z1" })).data.values?.[0] || [];
console.log("Orders header now:");
head.forEach((h, i) => console.log(`  ${String.fromCharCode(65 + i)} = ${h || "(empty)"}`));

const u = String(head[20] ?? "").trim();
if (u.toLowerCase() === "payment") { console.log("\nColumn U is already \"Payment\" — nothing to do."); process.exit(0); }
if (u) { console.error(`\nColumn U already holds "${u}". Not touching it — tell Claude.`); process.exit(1); }
if (head.length > 20) { console.error("\nThere is something to the right of column T. Not touching it — tell Claude."); process.exit(1); }

if (!process.argv.includes("--write")) {
  console.log("\nPreview: column U is empty. Run again with --write to put \"Payment\" in Orders!U1.");
  process.exit(0);
}
await sheets.spreadsheets.values.update({
  spreadsheetId: id, range: "Orders!U1", valueInputOption: "RAW", requestBody: { values: [["Payment"]] },
});
console.log("\nDone: Orders!U1 = Payment. Open the Order Desk and check it still loads and saves an order as before.");
