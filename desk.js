/**
 * Push completed bot sales into the Order Desk's Orders tab.
 *
 * The Desk is the system of record for sales across every channel — TikTok,
 * Viber and Telegram — so its Renewals list, Reports and 14-day calendar
 * reminders cover bot customers too, and nobody retypes anything.
 *
 * The bot's own sheet keeps what the Desk has no concept of: Products,
 * Inventory and account credentials, Settings, and the wallet ledger.
 *
 * Two rules shape everything below:
 *
 *   1. A Desk failure must never affect the customer. They have paid and are
 *      owed their product; a reporting sheet being unreachable is our problem,
 *      not theirs. Every call here is best-effort and reports to the admin.
 *
 *   2. Formats must match the Desk exactly. It matches Item and Duration as
 *      strings, and its two date columns use *different* formats in the same
 *      row (Date is DD/MM/YYYY, Expiry Date is YYYY-MM-DD). A near-miss row
 *      still appears in the sheet but silently drops out of every report,
 *      which is worse than an obvious error.
 */
import "dotenv/config";
import { google } from "googleapis";

const DESK_ID = process.env.DESK_SHEET_ID || "";

// Desk Orders columns, 1-based, mirroring ORDER_HEADERS in the Apps Script:
// 1 No · 2 Date · 3 Customer · 4 Start Time · 5 End Time · 6 Source · 7 Item
// 8 Seller Name · 9 Supplier · 10 Price · 11 Share/Private · 12 Payment check
// 13 Duration · 14 Zoom Email · 15 Purchase Price · 16 Track · 17 Expiry Date
// 18 Renewal Status · 19 Contacted On · 20 Reminder
const DESK_RANGE = "Orders!A:T";

// The Desk's Source list is: G-Tik · G-Tg · Y-Tg · Y-Viber · Y-Mesg
const SOURCE_TELEGRAM = "G-Tg";

let sheetsClient = null;
function client() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || "")
        .replace(/^["']|["']$/g, "")
        .replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/** True when a Desk sheet is configured at all. */
export function deskEnabled() {
  return Boolean(DESK_ID);
}

/**
 * Prices reach here as whatever the Products sheet holds — "95000", "95,000",
 * sometimes with a stray space. Number("95,000") is NaN, and defaulting that
 * to 0 writes a free sale into your revenue reports, which is worse than an
 * obviously wrong value. So: strip the formatting, and if it still can't be
 * read, pass the original text through so it's visible and fixable rather
 * than silently zero.
 */
function toMoney(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const cleaned = String(v ?? "").replace(/[^\d.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && cleaned !== "" ? n : String(v ?? "");
}

/** "2026-08-06 18:42" → "06/08/2026", the format the Desk's Date column uses. */
function toDeskDate(sheetDateTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(sheetDateTime || "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** "2026-08-06 18:42" → "18:42". */
function toDeskTime(sheetDateTime) {
  const m = /[ T](\d{2}:\d{2})/.exec(String(sheetDateTime || "").trim());
  return m ? m[1] : "";
}

/** "2027-02-06 18:42" → "2027-02-06". The Expiry column is date-only. */
function toDeskExpiry(sheetDateTime) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(sheetDateTime || "").trim());
  return m ? m[1] : "";
}

/**
 * The Desk's Access list is exactly Share / Private / Own, while the bot's
 * variant is free text ("Private Acc (6Month)", "Member License"). Returns ""
 * when it genuinely can't tell — a blank cell is honest, whereas guessing
 * would misreport what the customer bought and break the price lookup.
 */
function toDeskAccess(variant) {
  const v = String(variant || "").toLowerCase();
  if (v.includes("private")) return "Private";
  if (v.includes("share")) return "Share";
  if (v.includes("own")) return "Own";
  return "";
}

/** Next value for the Desk's "No" column. */
async function nextDeskNo(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: DESK_ID,
    range: "Orders!A2:A",
  });
  let max = 0;
  for (const r of res.data.values || []) {
    const n = parseInt(String(r[0] || "").trim(), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return max + 1;
}

/**
 * Build the 20-cell row. Exported separately from the write so it can be
 * tested without touching Google.
 *
 * `order`   – { customerName, dateTime, price, expiry }
 * `product` – the bot product row (needs deskItem, duration, variant)
 */
export function buildDeskRow({ no, order, product, seller = "Bot", zoomEmail = "" }) {
  return [
    no, // A  No
    toDeskDate(order.dateTime), // B  Date          DD/MM/YYYY
    order.customerName, // C  Customer
    toDeskTime(order.dateTime), // D  Start Time    HH:MM
    "", // E  End Time      (filled when the plan ends)
    SOURCE_TELEGRAM, // F  Source
    product.deskItem, // G  Item          must match Config exactly
    seller, // H  Seller Name
    "", // I  Supplier      the bot doesn't know this
    toMoney(order.price), // J  Price         the sell price

    toDeskAccess(product.variant), // K  Share/Private
    "Done", // L  Payment check  paid before we ever get here
    product.duration, // M  Duration      matches the Desk's list
    zoomEmail, // N  Zoom Email
    0, // O  Purchase Price
    true, // P  Track         so it appears in Renewals
    toDeskExpiry(order.expiry), // Q  Expiry Date   YYYY-MM-DD
    "", // R  Renewal Status
    "", // S  Contacted On
    false, // T  Reminder      the daily trigger sets this
  ];
}

/**
 * Fill in the Zoom Email cell for an order already on the Desk.
 *
 * Zoom customers give their email after the sale completes, so the row is
 * written first with the cell blank and updated when the address arrives. The
 * Desk's calendar reminder puts this address in the event description, which
 * is how you know who to chase every 14 days — a blank cell there means a
 * reminder you can't act on.
 *
 * Addressed by the Desk's own "No", found in column A. Never throws.
 */
export async function setZoomEmail(no, email) {
  if (!deskEnabled()) return { ok: false, skipped: "DESK_SHEET_ID not set" };
  if (!no || !email) return { ok: false, skipped: "missing order number or email" };

  try {
    const sheets = client();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: DESK_ID,
      range: "Orders!A2:A",
    });
    const rows = res.data.values || [];
    // Search from the bottom: this always concerns a sale made moments ago.
    let rowNumber = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0] || "").trim() === String(no)) {
        rowNumber = i + 2;
        break;
      }
    }
    if (rowNumber === -1) return { ok: false, error: `Desk row No. ${no} not found` };

    await sheets.spreadsheets.values.update({
      spreadsheetId: DESK_ID,
      range: `Orders!N${rowNumber}`, // N = Zoom Email
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[email]] },
    });
    return { ok: true, rowNumber };
  } catch (e) {
    console.error("setZoomEmail:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Read back a few fields the reminder needs, and tick the Reminder flag.
 *
 * Ticking it is what stops the Apps Script safety-net trigger creating a
 * second calendar series for an order the bot has already handled. The two
 * systems coordinate through this one cell.
 */
export async function markReminderDone(no) {
  if (!deskEnabled() || !no) return { ok: false, skipped: "no Desk row" };
  try {
    const sheets = client();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: DESK_ID,
      range: "Orders!A2:A",
    });
    const rows = res.data.values || [];
    let rowNumber = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][0] || "").trim() === String(no)) {
        rowNumber = i + 2;
        break;
      }
    }
    if (rowNumber === -1) return { ok: false, error: `Desk row No. ${no} not found` };

    await sheets.spreadsheets.values.update({
      spreadsheetId: DESK_ID,
      range: `Orders!T${rowNumber}`, // T = Reminder
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[true]] },
    });
    return { ok: true, rowNumber };
  } catch (e) {
    console.error("markReminderDone:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Record a completed sale on the Desk. Never throws: returns a small result
 * object so the caller can tell the admin without interrupting delivery.
 */
export async function pushOrderToDesk({ order, product, seller, zoomEmail }) {
  if (!deskEnabled()) return { ok: false, skipped: "DESK_SHEET_ID not set" };

  // No mapping means this product deliberately isn't synced. Not an error.
  if (!product || !product.deskItem) {
    return { ok: false, skipped: `no Desk Item mapping for "${product?.name || "?"}"` };
  }

  try {
    const sheets = client();
    const no = await nextDeskNo(sheets);
    const row = buildDeskRow({ no, order, product, seller, zoomEmail });

    await sheets.spreadsheets.values.append({
      spreadsheetId: DESK_ID,
      range: DESK_RANGE,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });

    return { ok: true, no, item: product.deskItem };
  } catch (e) {
    console.error("pushOrderToDesk:", e.message);
    return { ok: false, error: e.message };
  }
}
