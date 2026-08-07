import "dotenv/config";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Service-account credentials, resolved in this order:
 *   1. GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY   (cloud hosting)
 *   2. GOOGLE_CREDENTIALS_JSON — the whole key file as one string
 *   3. a service-account .json file sitting next to this script (local dev)
 *
 * The .json key is gitignored (correctly — it holds a private key), so it does
 * NOT exist on a deployed server. Without the env-var paths below the bot would
 * start fine locally and then crash on boot in the cloud.
 */
function loadCredentials() {
  const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (client_email && rawKey) {
    return {
      client_email,
      // Hosting dashboards can't store real newlines, so the key is pasted with
      // literal "\n" sequences; turn them back into newlines. Stray wrapping
      // quotes (which some dashboards keep) are stripped too — both are the
      // classic "invalid PEM / DECODER routines" deploy failure.
      private_key: rawKey.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n"),
    };
  }

  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }

  const localKey = fs
    .readdirSync(__dirname)
    .find((f) => /^digital-shop-bot-.*\.json$/.test(f) || f === "google-credentials.json");
  if (localKey) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, localKey), "utf-8"));
  }

  throw new Error(
    "No Google credentials found. Set GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY " +
      "(or GOOGLE_CREDENTIALS_JSON), or keep the service-account .json next to sheets.js."
  );
}

const credentials = loadCredentials();
const spreadsheetId = process.env.GOOGLE_SHEET_ID;
if (!spreadsheetId) {
  throw new Error("Missing GOOGLE_SHEET_ID — set it in .env or in your host's variables.");
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ─── Read cache ──────────────────────────────────────────────────────────────
// Every button tap used to re-read whole tabs from the Sheets API, and each of
// those round trips costs a few hundred milliseconds. One product detail card
// did three or four of them back to back, so a tap felt like a second or more
// of nothing happening.
//
// These tabs are edited by hand and change rarely, so a short TTL makes taps
// feel instant while still picking up sheet edits within a minute. Anything
// that has to be exact at the instant it is read — the inventory row we are
// about to sell, order lookups — bypasses the cache entirely.
const TTL = {
  products: 60_000,
  settings: 60_000,
  tips: 300_000,
  faq: 300_000,
  inventory: 10_000, // display counts only; the sell path always reads fresh
};

const cache = new Map();

function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.promise;

  // Cache the promise rather than the resolved value: when several customers
  // tap at the same moment they share one API call instead of firing one each.
  const promise = loader().catch((err) => {
    cache.delete(key); // never let a failed read stick around
    throw err;
  });
  cache.set(key, { promise, expires: Date.now() + ttlMs });
  return promise;
}

/** Drop cached tabs so the next read is fresh. Called after every write. */
export function invalidate(...keys) {
  if (keys.length === 0) return cache.clear();
  for (const k of keys) cache.delete(k);
}

/** Warm the read-mostly tabs at boot so the first customer isn't the one who
 *  pays the cold-start cost. Failures are non-fatal — normal reads will retry. */
export async function warmCache() {
  try {
    await Promise.all([getSettings(), getProducts(), getFaqRows(), getTips()]);
  } catch (e) {
    console.warn("warmCache:", e.message);
  }
}

// ─── Sheet layout (kept in one place so column maths stays readable) ──────────
// Products:  A Product ID | B Product Name | C Variant | D Type | E Price (MMK)
//            | F Description | G Active | H Promo | I Promo Price | J Duration
//            | K Icon | L Category
// Tips:      A Key (Product Name, "Name | Variant", or Type) | B Tips
// FAQ:       A Key (Product Name) | B Question | C Answer | D Image (filename)
// Inventory: A Inventory ID | B Product ID | C Account Credentials | D Status
//            | E Sold To (Username) | F Sold Date/Time | G Order ID
// Orders:    A Order ID | B Date Created | C Customer Username | D Customer Chat ID
//            | E Product ID | F Product Name | G Variant | H Price (MMK)
//            | I Payment Status | J Payslip Sent | K Admin Decision
//            | L Decision Time | M Delivery Status | N Inventory ID Used
//            | O Credentials Sent | P Used Date/Time | Q Notes
// Settings:  A Key | B Value | C Notes
// Wallets:   A ChatID | B Username | C Balance (MMK) | D Last Updated
// WalletTx:  A Tx ID | B Date | C ChatID | D Username | E Type (TopUp/Purchase)
//            | F Amount (+/-) | G Balance After | H Order/Ref ID | I Notes

// Order column letters keyed by the field names used across the app.
const ORDER_COLS = {
  orderId: "A",
  dateCreated: "B",
  customerUsername: "C",
  customerChatId: "D",
  productId: "E",
  productName: "F",
  variant: "G",
  price: "H",
  paymentStatus: "I",
  payslipSent: "J",
  adminDecision: "K",
  decisionTime: "L",
  deliveryStatus: "M",
  inventoryIdUsed: "N",
  credentialsSent: "O",
  usedDateTime: "P",
  notes: "Q",
  expiryDate: "R",
};

/** "YYYY-MM-DD HH:MM" in local time, matching the existing sheet format. */
export function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ─── Duration & expiry ───────────────────────────────────────────────────────
// The Duration column is free text a human types — "6 Month", "6Month",
// "1 Year", "30 Days" have all appeared. Nothing downstream (renewal
// reminders, a dashboard, churn tracking) can work until that becomes a real
// date, so parsing is deliberately forgiving about spacing, case, plurals and
// common abbreviations, and returns null rather than guessing when it can't
// tell — a wrong expiry date is worse than a missing one.

/** "6 Month" → { months: 6 }.  "30 days" → { days: 30 }.  null if unparseable. */
export function parseDuration(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (!t) return null;

  const m = /(\d+)\s*(days?|d|weeks?|w|months?|mons?|m|years?|yrs?|y)\b/.exec(t);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];

  if (/^d(ays?)?$/.test(unit)) return { days: n };
  if (/^w(eeks?)?$/.test(unit)) return { days: n * 7 };
  if (/^(m|mons?|months?)$/.test(unit)) return { months: n };
  if (/^(y|yrs?|years?)$/.test(unit)) return { months: n * 12 };
  return null;
}

/** Parse the "YYYY-MM-DD HH:MM" format used throughout the sheet.
 *
 *  Rejects dates that don't exist rather than letting them roll over: given
 *  "2026-02-29" (2026 is not a leap year) the Date constructor happily returns
 *  1 March, which would produce a confident but wrong expiry a year later.
 *  Better to return null and leave expiry blank than to invent a date. */
function parseSheetDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || "").trim());
  if (!m) return null;

  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, day, Number(m[4] || 0), Number(m[5] || 0));
  if (isNaN(d.getTime())) return null;

  // If any component changed, the input named a day that doesn't exist.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return d;
}

function formatSheetDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Add a parsed duration to a sheet date string. Returns "" when either input
 * is unusable, so a product with a blank or odd Duration simply gets no expiry
 * instead of a nonsense one.
 *
 * Month arithmetic clamps to the end of the target month: 31 Jan + 1 month is
 * 28 Feb, not 3 Mar. JavaScript's setMonth rolls over by default, which would
 * silently hand customers extra days every time they bought at month end.
 */
export function addDuration(startStr, duration) {
  const start = parseSheetDate(startStr);
  if (!start || !duration) return "";

  const d = new Date(start.getTime());
  if (duration.days) {
    d.setDate(d.getDate() + duration.days);
  } else if (duration.months) {
    const targetDay = d.getDate();
    d.setDate(1); // avoid rollover while changing month
    d.setMonth(d.getMonth() + duration.months);
    const lastDayOfTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(targetDay, lastDayOfTarget));
  } else {
    return "";
  }
  return formatSheetDate(d);
}

/** Expiry for an order delivered at `startStr` for a product with `durationText`. */
export function expiryFor(startStr, durationText) {
  return addDuration(startStr, parseDuration(durationText));
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Read the Settings tab into a plain object keyed by the Key column.
 * Always read live — payment/admin details must never be hardcoded.
 */
export async function getSettings() {
  return cached("settings", TTL.settings, async () => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Settings!A2:B",
    });
    const rows = res.data.values || [];
    const out = {};
    for (const row of rows) {
      const key = (row[0] || "").trim();
      if (key) out[key] = (row[1] || "").trim();
    }
    return out;
  });
}

/**
 * Upsert a single Settings key/value. Updates the existing row if the key is
 * present, otherwise appends a new row. Used to persist the admin's chat ID.
 */
export async function setSetting(key, value) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Settings!A2:A",
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex((r) => (r[0] || "").trim() === key);
  if (idx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Settings!A:C",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[key, value, "Set automatically by bot"]] },
    });
  } else {
    const sheetRow = idx + 2; // data starts at row 2
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Settings!B${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] },
    });
  }
  invalidate("settings"); // the cached copy is now stale
}

// ─── Products (catalog only — no stock, no credentials) ──────────────────────

/**
 * Normalize the Type column to one of two canonical values:
 *   "auto"   → delivered instantly from Inventory (old name: "ready")
 *   "manual" → handed off to admin to set up (old name: "email")
 * Both the old and new sheet words are accepted so nothing breaks before the
 * sheet's Type values are migrated.
 */
export function normalizeType(raw) {
  const t = (raw || "").toLowerCase().trim();
  if (t === "auto" || t === "ready") return "auto";
  if (t === "manual" || t === "email") return "manual";
  return "auto"; // safe default: treat unknown as auto-delivery
}

/**
 * Map raw Products values (INCLUDING the header row) to product objects, reading
 * columns BY HEADER NAME so the sheet's column order can drift without breaking.
 * Duplicate headers (e.g. two "Duration" columns) resolve to the first one.
 */
export function mapProductsFromValues(values) {
  const headers = (values[0] || []).map((h) => (h || "").trim().toLowerCase());
  const find = (...cands) => {
    for (const c of cands) {
      const i = headers.findIndex((h) => h === c);
      if (i !== -1) return i;
    }
    for (const c of cands) {
      const i = headers.findIndex((h) => h.includes(c));
      if (i !== -1) return i;
    }
    return -1;
  };
  const iId = find("product id", "id");
  const iName = find("product name", "name");
  const iVariant = find("variant");
  const iType = find("type");
  const iPrice = find("price"); // exact "price" wins over "promo price"
  const iDesc = find("description");
  const iDuration = find("duration");
  const iActive = find("active");
  const iPromo = find("promo"); // exact "promo" wins over "promo price"
  const iPromoPrice = find("promo price");
  const iIcon = find("icon");
  const iCategory = find("category");
  const iLogo = find("logo");
  // What this product is called on the Order Desk. Blank means "don't send
  // this one across" — see desk.js.
  const iDeskItem = find("desk item");
  const g = (r, i) => (i > -1 ? r[i] || "" : "");

  return values
    .slice(1)
    .filter((r) => g(r, iId).trim()) // must have a Product ID
    .map((r) => ({
      id: g(r, iId).trim(),
      name: g(r, iName).trim(),
      variant: g(r, iVariant).trim(),
      type: normalizeType(g(r, iType)), // "auto" | "manual"
      price: (g(r, iPrice) || "0").toString().trim(),
      description: g(r, iDesc),
      active: g(r, iActive).trim(),
      promo: g(r, iPromo).toLowerCase().trim() === "yes",
      promoPrice: g(r, iPromoPrice).toString().trim(),
      duration: g(r, iDuration).trim(),
      icon: g(r, iIcon).trim(),
      category: g(r, iCategory).trim(),
      logo: g(r, iLogo).trim(),
      deskItem: g(r, iDeskItem).trim(),
    }))
    .filter((p) => p.active.toLowerCase() !== "no");
}

/**
 * Read the Products tab (active products only), keyed by header name so column
 * order is irrelevant. See mapProductsFromValues for the field list.
 */
export async function getProducts() {
  return cached("products", TTL.products, async () => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Products!A1:Z",
    });
    return mapProductsFromValues(res.data.values || []);
  });
}

/**
 * Effective price for a product: the promo price when the product is on promo
 * AND a promo price is set, otherwise the regular price. Returns a string.
 */
export function effectivePrice(p) {
  return p.promo && p.promoPrice ? p.promoPrice : p.price;
}

// ─── Tips (per-product advice sent on delivery; editable in the sheet) ───────

/**
 * Read the Tips tab into a lookup keyed by lowercased Key. Keys may be a
 * Product Name (e.g. "quillbot") or a Type ("auto" / "manual"). Returns {} if
 * the tab is missing so the bot keeps working without it.
 */
export async function getTips() {
  return cached("tips", TTL.tips, async () => {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Tips!A2:B",
      });
      const rows = res.data.values || [];
      const out = {};
      for (const row of rows) {
        const key = (row[0] || "").trim().toLowerCase();
        if (key) out[key] = (row[1] || "").trim();
      }
      return out;
    } catch (e) {
      console.warn("getTips: Tips tab not available —", e.message);
      return {};
    }
  });
}

/**
 * Resolve the tips text for a product, most specific first:
 *   1. "Product Name | Variant"  (per-variant reminder, e.g. Share vs Private)
 *   2. "Product Name"            (whole product)
 *   3. Type                      ("auto" / "manual")
 * Returns "" when nothing matches.
 */
export async function resolveTips(product) {
  const tips = await getTips();
  const nameVariant = `${product.name} | ${product.variant}`.toLowerCase();
  return (
    tips[nameVariant] ||
    tips[product.name.toLowerCase()] ||
    tips[product.type] ||
    ""
  );
}

// ─── FAQ (per-product Q&A button on the detail card) ─────────────────────────

/**
 * Read every FAQ row as an array of
 * { rowNumber, key, question, answer, image }.
 * A product can have several FAQ rows (several question buttons). `image` is an
 * optional filename in faq-images/ — when set, the answer is sent as a photo.
 * rowNumber is the stable handle used in the button callback.
 */
export async function getFaqRows() {
  return cached("faq", TTL.faq, async () => {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "FAQ!A2:D",
      });
      const rows = res.data.values || [];
      return rows
        .map((row, i) => ({
          rowNumber: i + 2,
          key: (row[0] || "").trim(),
          question: (row[1] || "").trim(),
          answer: (row[2] || "").trim(),
          image: (row[3] || "").trim(),
        }))
        .filter((f) => f.key && f.question && (f.answer || f.image));
    } catch (e) {
      console.warn("getFaqRows: FAQ tab not available —", e.message);
      return [];
    }
  });
}

/** All FAQ rows for a product (by Product Name), in sheet order. */
export async function getFaqsForProduct(product) {
  const rows = await getFaqRows();
  const name = product.name.toLowerCase();
  return rows.filter((f) => f.key.toLowerCase() === name);
}

/** One FAQ by its sheet row number (from the button callback), or null. */
export async function getFaqByRow(rowNumber) {
  const rows = await getFaqRows();
  return rows.find((f) => f.rowNumber === Number(rowNumber)) || null;
}

/** Find one product by its Product ID (the join key). */
export async function getProductById(productId) {
  const products = await getProducts();
  return products.find((p) => p.id === productId) || null;
}

// ─── Inventory (real accounts; live stock) ───────────────────────────────────

/**
 * Read the Inventory tab as objects, preserving the sheet row number so we can
 * update a specific row later.
 */
async function fetchInventory() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Inventory!A2:G",
  });
  const rows = res.data.values || [];
  return rows
    .map((row, i) => ({
      rowNumber: i + 2, // data starts at row 2
      inventoryId: (row[0] || "").trim(),
      productId: (row[1] || "").trim(),
      credentials: row[2] || "",
      status: (row[3] || "").trim(),
      soldTo: row[4] || "",
      soldDateTime: row[5] || "",
      orderId: row[6] || "",
    }))
    .filter((r) => r.inventoryId); // skip blank rows
}

/** Cached inventory — fine for showing stock counts while browsing. */
async function getInventory() {
  return cached("inventory", TTL.inventory, fetchInventory);
}

/**
 * Live stock for a ready product = number of Inventory rows with this Product ID
 * and Status "Available". Never stored — always counted.
 */
export async function countAvailableStock(productId) {
  const inv = await getInventory();
  return inv.filter(
    (r) => r.productId === productId && r.status.toLowerCase() === "available"
  ).length;
}

/** First Available Inventory row for a product, or null if sold out.
 *  Deliberately reads FRESH (never cached): this is the row we are about to
 *  sell, and handing two customers the same account because of a stale read
 *  would be a real problem, unlike a stock count that is a few seconds old. */
export async function getAvailableInventory(productId) {
  const inv = await fetchInventory();
  return (
    inv.find(
      (r) => r.productId === productId && r.status.toLowerCase() === "available"
    ) || null
  );
}

/**
 * Mark an Inventory row Sold and stamp who/when/which order.
 * Pass the rowNumber from getAvailableInventory so we update the exact account.
 */
export async function markInventorySold(rowNumber, { soldTo, orderId }) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Inventory!D${rowNumber}:G${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["Sold", soldTo, now(), orderId]] },
  });
  invalidate("inventory"); // stock just changed — don't show the old count
}

// ─── Narrow reads ────────────────────────────────────────────────────────────
// Orders and WalletTx grow forever — roughly 400 new order rows a month here.
// Pulling the whole tab to find one customer's last 10 orders means the read
// gets steadily heavier every month for a result that never changes size.
//
// Instead: scan ONE narrow column (chat id, or order id) to work out which row
// numbers we actually want, then fetch just those rows. A single column is
// ~17x lighter than 17 columns, and the second call is a handful of rows, so
// the cost stays roughly flat as the sheet grows.
//
// This stays exact — no "only look at recent rows" window that would quietly
// hide a returning customer's older orders.

/** One column as trimmed strings, index 0 = sheet row 2. */
async function readColumn(range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values || []).map((r) => String(r[0] || "").trim());
}

/** Specific row numbers as full rows, fetched in a single batch call. */
async function readRows(tab, rowNumbers, lastCol) {
  if (rowNumbers.length === 0) return [];
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: rowNumbers.map((n) => `${tab}!A${n}:${lastCol}${n}`),
  });
  return (res.data.valueRanges || []).map((vr, i) => ({
    rowNumber: rowNumbers[i],
    values: (vr.values && vr.values[0]) || [],
  }));
}

// ─── Orders ──────────────────────────────────────────────────────────────────

/** Highest existing Order number in the sheet (0 when none).
 *  Reads column A only — the one remaining full-column scan, kept exact
 *  because a duplicated Order ID would be far worse than a slightly heavier
 *  read, and it is still ~17x lighter than pulling every column. */
export async function getMaxOrderNumber() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Orders!A2:A",
  });
  const ids = (res.data.values || []).map((r) => (r[0] || "").trim());
  let max = 0;
  for (const id of ids) {
    const m = id.match(/ORD-(\d+)/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/** Next auto-increment Order ID, e.g. "ORD-0001". */
async function nextOrderId() {
  return `ORD-${String((await getMaxOrderNumber()) + 1).padStart(4, "0")}`;
}

/**
 * Append an order row. The row is written only when we actually want it recorded
 * (i.e. on Verify) — pass the pre-reserved `orderId` and the final field values.
 * Anything omitted falls back to the "fresh order" defaults.
 */
export async function createOrder({
  orderId,
  dateCreated,
  customerUsername,
  customerChatId,
  productId,
  productName,
  variant,
  price,
  paymentStatus = "Awaiting Payslip",
  payslipSent = "No",
  adminDecision = "Pending",
  decisionTime = "",
  deliveryStatus = "Not Delivered",
  inventoryIdUsed = "",
  credentialsSent = "",
  usedDateTime = "",
  notes = "",
  expiryDate = "",
}) {
  const id = orderId || (await nextOrderId());
  const row = [
    id, // A Order ID
    dateCreated || now(), // B Date Created
    customerUsername, // C Customer Username
    customerChatId, // D Customer Chat ID
    productId, // E Product ID
    productName, // F Product Name
    variant, // G Variant
    price, // H Price (MMK)
    paymentStatus, // I Payment Status
    payslipSent, // J Payslip Sent
    adminDecision, // K Admin Decision
    decisionTime, // L Decision Time
    deliveryStatus, // M Delivery Status
    inventoryIdUsed, // N Inventory ID Used
    credentialsSent, // O Credentials Sent
    usedDateTime, // P Used Date/Time
    notes, // Q Notes
    expiryDate, // R Expiry Date
  ];
  await ensureOrderExpiryColumn();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Orders!A:R",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  return id;
}

/**
 * Make sure Orders has an "Expiry Date" header in column R.
 *
 * Same reasoning as ensureWalletTabs: requiring a manual sheet edit before a
 * release works is a step that gets forgotten, and the failure shows up as a
 * blank column nobody notices rather than a loud error. Cached after the first
 * success so it costs one read at startup, not one per order.
 */
let expiryColumnReady = null;
export function ensureOrderExpiryColumn() {
  if (expiryColumnReady) return expiryColumnReady;

  expiryColumnReady = (async () => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Orders!R1",
    });
    const existing = ((res.data.values || [])[0] || [])[0];
    if (existing && String(existing).trim()) return true;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Orders!R1",
      valueInputOption: "RAW",
      requestBody: { values: [["Expiry Date"]] },
    });
    console.log('✔ Added "Expiry Date" header to Orders!R1');
    return true;
  })().catch((e) => {
    expiryColumnReady = null; // retry next time rather than caching a failure
    throw e;
  });

  return expiryColumnReady;
}

/** Map a raw Orders sheet row (array) to an order object, given its row index. */
function rowToOrder(r, rowNumber) {
  return {
    rowNumber,
    orderId: (r[0] || "").trim(),
    dateCreated: r[1] || "",
    customerUsername: r[2] || "",
    customerChatId: r[3] || "",
    productId: (r[4] || "").trim(),
    productName: r[5] || "",
    variant: r[6] || "",
    price: r[7] || "",
    paymentStatus: r[8] || "",
    payslipSent: r[9] || "",
    adminDecision: r[10] || "",
    decisionTime: r[11] || "",
    deliveryStatus: r[12] || "",
    inventoryIdUsed: r[13] || "",
    credentialsSent: r[14] || "",
    usedDateTime: r[15] || "",
    notes: r[16] || "",
    expiryDate: r[17] || "",
  };
}

/**
 * All orders for one customer chat id, newest first. Used by Order History.
 * `limit` caps how many are returned (default 10).
 */
export async function getOrdersByChatId(chatId, limit = 10) {
  // Column D is the customer chat id. Walk it from the bottom so the newest
  // orders are found first and we can stop as soon as we have `limit` of them.
  const ids = await readColumn("Orders!D2:D");
  const wanted = [];
  for (let i = ids.length - 1; i >= 0 && wanted.length < limit; i--) {
    if (ids[i] === String(chatId)) wanted.push(i + 2);
  }
  const rows = await readRows("Orders", wanted, "Q");
  return rows.map((r) => rowToOrder(r.values, r.rowNumber)); // already newest first
}

/**
 * Unique customer chat IDs from the Orders tab — the audience for broadcasts.
 * A bot can only message users who have interacted with it, and an order is
 * the point where we capture a chat ID, so past buyers are the reachable set.
 */
export async function getAllCustomerChatIds() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Orders!D2:D",
  });
  const rows = res.data.values || [];
  const set = new Set();
  for (const r of rows) {
    const id = (r[0] || "").toString().trim();
    if (id) set.add(id);
  }
  return [...set];
}

/** Find an order by Order ID. Returns an object with rowNumber, or null.
 *  Searches column A from the bottom: the orders being acted on are almost
 *  always recent ones, so the match is usually found immediately. */
export async function getOrderByOrderId(orderId) {
  const ids = await readColumn("Orders!A2:A");
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i] === orderId) {
      const [row] = await readRows("Orders", [i + 2], "Q");
      return row ? rowToOrder(row.values, row.rowNumber) : null;
    }
  }
  return null;
}

/**
 * Update one or more fields of an order, addressed by Order ID. `fields` keys
 * use the names in ORDER_COLS (e.g. { paymentStatus: "Cancelled" }). Each field
 * is written to its own cell so unrelated columns are never touched.
 */
export async function updateOrderByOrderId(orderId, fields) {
  const order = await getOrderByOrderId(orderId);
  if (!order) throw new Error(`Order "${orderId}" not found`);
  const data = [];
  for (const [key, value] of Object.entries(fields)) {
    const col = ORDER_COLS[key];
    if (!col) throw new Error(`Unknown order field "${key}"`);
    data.push({
      range: `Orders!${col}${order.rowNumber}`,
      values: [[value]],
    });
  }
  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
}

// ─── Wallet ──────────────────────────────────────────────────────────────────
// Two new tabs, created by hand in the spreadsheet before this ships:
//   Wallets:  A ChatID | B Username | C Balance (MMK) | D Last Updated
//   WalletTx: A Tx ID | B Date | C ChatID | D Username | E Type
//             (TopUp / Purchase) | F Amount (+/-) | G Balance After
//             | H Order/Ref ID | I Notes
//
// Balance is always read fresh here, never through the TTL cache above — it's
// money, and a customer buying twice off a stale cached balance is a real
// problem in a way a stale product list is not. Sheets isn't transactional,
// so a genuinely simultaneous double-tap from the same customer could in
// theory race past the check-then-write in chargeWallet; that risk is
// accepted at this bot's volume, the same trade-off already made for
// Inventory (see markInventorySold above).

/**
 * Create the Wallets / WalletTx tabs (with headers) if they're missing.
 *
 * Reads can shrug off a missing tab by returning 0 or [], but every write
 * path — reserving a Tx ID, crediting, appending a ledger row — genuinely
 * needs the tab to exist, and Google's "Unable to parse range" error is
 * opaque when it surfaces to a customer. Creating them on demand removes the
 * manual setup step (and the class of bug where it's forgotten) entirely.
 *
 * Runs at most once per process: after the first success the promise is
 * cached, so this costs one metadata call at startup, not one per top-up.
 */
let walletTabsReady = null;
export function ensureWalletTabs() {
  if (walletTabsReady) return walletTabsReady;

  walletTabsReady = (async () => {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    const existing = new Set((meta.data.sheets || []).map((s) => s.properties.title));

    const wanted = [
      { title: "Wallets", headers: ["ChatID", "Username", "Balance (MMK)", "Last Updated"] },
      {
        title: "WalletTx",
        headers: [
          "Tx ID", "Date", "ChatID", "Username", "Type",
          "Amount (+/-)", "Balance After", "Order/Ref ID", "Notes",
        ],
      },
    ].filter((t) => !existing.has(t.title));

    if (wanted.length === 0) return true;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: wanted.map((t) => ({ addSheet: { properties: { title: t.title } } })),
      },
    });
    for (const t of wanted) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${t.title}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [t.headers] },
      });
      console.log(`✔ Created missing "${t.title}" tab`);
    }
    return true;
  })().catch((e) => {
    walletTabsReady = null; // let a later call retry rather than caching failure
    throw e;
  });

  return walletTabsReady;
}

/** Same "tab might not exist yet" tolerance as getTips/getFaqRows above — a
 *  customer whose wallet checkout falls back to bank transfer because the
 *  Wallets tab isn't there yet is fine; a purchase silently failing is not. */
async function findWalletRow(chatId) {
  try {
    // Column A holds the chat ids — scan that, then pull only the one row.
    const ids = await readColumn("Wallets!A2:A");
    const i = ids.indexOf(String(chatId));
    if (i === -1) return null;

    const [row] = await readRows("Wallets", [i + 2], "D");
    if (!row) return null;
    return {
      rowNumber: row.rowNumber,
      chatId: String(row.values[0] || "").trim(),
      username: row.values[1] || "",
      balance: Number(row.values[2] || 0),
    };
  } catch (e) {
    console.warn("findWalletRow: Wallets tab not available —", e.message);
    return null;
  }
}

/** Current wallet balance for a customer. 0 if they have never topped up. */
export async function getWalletBalance(chatId) {
  const row = await findWalletRow(chatId);
  return row ? row.balance : 0;
}

async function appendWalletTx({ txId, chatId, username, type, amount, balanceAfter, refId, notes }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "WalletTx!A:I",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[txId, now(), chatId, username, type, amount, balanceAfter, refId || "", notes || ""]],
    },
  });
}

/**
 * Reserve the next Wallet Transaction ID (WTX-0001, WTX-0002, ...), accounting
 * for both the sheet and any top-up requests still pending in memory — same
 * pattern as reserveOrderId in index.js, just for the wallet ledger.
 */
export async function reserveWalletTxId(pendingIds = []) {
  await ensureWalletTabs();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "WalletTx!A2:A",
  });
  const rows = res.data.values || [];
  let max = 0;
  for (const r of rows) {
    const m = /WTX-(\d+)/i.exec(r[0] || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  for (const id of pendingIds) {
    const m = /WTX-(\d+)/i.exec(id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `WTX-${String(max + 1).padStart(4, "0")}`;
}

/**
 * Credit a customer's wallet — used once the admin approves a top-up payslip.
 * Creates the Wallets row on a customer's first-ever top-up. Returns the new
 * balance.
 */
export async function creditWallet({ chatId, username, amount, txId, notes }) {
  await ensureWalletTabs();
  const row = await findWalletRow(chatId);
  const current = row ? row.balance : 0;
  const newBalance = current + Number(amount);

  if (row) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Wallets!C${row.rowNumber}:D${row.rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newBalance, now()]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Wallets!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[chatId, username, newBalance, now()]] },
    });
  }
  await appendWalletTx({
    txId,
    chatId,
    username,
    type: "TopUp",
    amount: Number(amount),
    balanceAfter: newBalance,
    notes,
  });
  return newBalance;
}

/**
 * Debit a customer's wallet for a purchase, but ONLY if the balance still
 * covers it at the exact moment of writing (re-read fresh, not the balance
 * the menu showed a moment ago). Returns the new balance, or null when the
 * funds weren't there — the caller must not deliver the product in that case.
 */
export async function chargeWallet({ chatId, username, amount, orderId }) {
  await ensureWalletTabs();
  const amt = Number(amount);
  // A non-numeric or non-positive amount must never reach the sheet — refuse
  // rather than risk writing NaN into someone's balance.
  if (!Number.isFinite(amt) || amt <= 0) return null;

  const row = await findWalletRow(chatId);
  const current = row ? row.balance : 0;
  if (!row || current < amt) return null;

  const newBalance = current - amt;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Wallets!C${row.rowNumber}:D${row.rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newBalance, now()]] },
  });
  const txId = `WTX-${orderId.replace(/^ORD-/, "")}`; // ties the tx to the order at a glance
  await appendWalletTx({
    txId,
    chatId,
    username,
    type: "Purchase",
    amount: -amt,
    balanceAfter: newBalance,
    refId: orderId,
  });
  return newBalance;
}

/** Most recent wallet transactions for a customer, newest first. Empty list
 *  (not a thrown error) if the WalletTx tab isn't there yet. */
export async function getWalletTransactions(chatId, limit = 5) {
  try {
    // Column C is the chat id. Same bottom-up scan as order history: the
    // ledger only ever grows, but the answer is always the newest few rows.
    const ids = await readColumn("WalletTx!C2:C");
    const wanted = [];
    for (let i = ids.length - 1; i >= 0 && wanted.length < limit; i--) {
      if (ids[i] === String(chatId)) wanted.push(i + 2);
    }
    const rows = await readRows("WalletTx", wanted, "I");
    return rows.map(({ values: r }) => ({
      txId: r[0] || "",
      date: r[1] || "",
      type: r[4] || "",
      amount: Number(r[5] || 0),
      balanceAfter: Number(r[6] || 0),
      refId: r[7] || "",
    }));
  } catch (e) {
    console.warn("getWalletTransactions: WalletTx tab not available —", e.message);
    return [];
  }
}
