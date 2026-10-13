/**
 * Print the shape of the Order Desk (and the bot's Products sheet) so the staff
 * order flow can be built against the real thing.
 *
 *   node desk-schema.mjs
 *
 * READ-ONLY (readonly scope). It prints:
 *   - every tab with its header row,
 *   - the Config tab grouped by category (the lists: Item, Source, ...),
 *   - the first rows of any tab that looks like a price book (has price + item
 *     columns but no customer/email/name column),
 *   - a few rows of the bot's Products sheet (catalogue, not customers).
 * It never prints rows from Orders or from any tab with customer columns.
 */
import "dotenv/config";
import { google } from "googleapis";

const DESK_ID = process.env.DESK_SHEET_ID || "";
const BOT_ID = process.env.GOOGLE_SHEET_ID || "";
if (!DESK_ID) {
  console.error("DESK_SHEET_ID is not set in .env");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/^["']|["']$/g, "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const get = async (id, range) => (await sheets.spreadsheets.values.get({ spreadsheetId: id, range })).data.values || [];
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
const cut = (v) => String(v ?? "").slice(0, 40);
const has = (headers, re) => headers.some((h) => re.test(h));

const meta = await sheets.spreadsheets.get({ spreadsheetId: DESK_ID, fields: "properties.title,sheets.properties(title,gridProperties)" });
console.log(`Order Desk: "${meta.data.properties.title}"\n`);

for (const s of meta.data.sheets) {
  const t = s.properties.title;
  const g = s.properties.gridProperties;
  let head = [];
  try {
    head = ((await get(DESK_ID, `'${t}'!1:1`))[0] || []).map((h) => String(h ?? "").trim());
  } catch (e) {
    console.log(`[${t}] could not read: ${e.message}`);
    continue;
  }
  console.log(`[${t}]  ${g.rowCount} rows x ${g.columnCount} cols`);
  console.log("  header: " + head.map((h, i) => `${colLetter(i)}=${cut(h) || "(blank)"}`).join(" | "));

  const lower = head.map((h) => h.toLowerCase());
  const looksLikeCustomers = has(lower, /customer|email|phone|viber|username|contact/);
  const looksLikePrices = has(lower, /price|cost/) && has(lower, /item|product/);

  if (t === "Config") {
    const rows = await get(DESK_ID, `'Config'!A2:H`);
    const by = new Map();
    for (const r of rows) {
      const k = String(r[0] ?? "").trim();
      if (!k) continue;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    for (const [k, list] of by) {
      console.log(`  Config category "${k}": ${list.length} value(s)`);
      for (const r of list.slice(0, 60)) console.log("     " + r.slice(1).map(cut).join(" | "));
    }
  } else if (looksLikePrices && !looksLikeCustomers && t !== "Orders") {
    const rows = await get(DESK_ID, `'${t}'!A2:J14`);
    console.log("  looks like a price list — first rows:");
    for (const r of rows) console.log("     " + r.map(cut).join(" | "));
  } else if (looksLikeCustomers) {
    console.log("  (has customer columns — rows not printed)");
  }
  console.log("");
}

if (BOT_ID) {
  console.log("Bot sheet 'Products' (catalogue):");
  const rows = await get(BOT_ID, "Products!A1:Z16");
  for (const r of rows) console.log("     " + r.map(cut).join(" | "));
}
