import "dotenv/config";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credentials = JSON.parse(
  fs.readFileSync(path.join(__dirname, "google-credentials.json"), "utf-8")
);
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ─── Sheet layout (kept in one place so column maths stays readable) ──────────
// Products:  A Product ID | B Product Name | C Variant | D Type | E Price (MMK)
//            | F Description | G Active
// Inventory: A Inventory ID | B Product ID | C Account Credentials | D Status
//            | E Sold To (Username) | F Sold Date/Time | G Order ID
// Orders:    A Order ID | B Date Created | C Customer Username | D Customer Chat ID
//            | E Product ID | F Product Name | G Variant | H Price (MMK)
//            | I Payment Status | J Payslip Sent | K Admin Decision
//            | L Decision Time | M Delivery Status | N Inventory ID Used
//            | O Credentials Sent | P Used Date/Time | Q Notes
// Settings:  A Key | B Value | C Notes

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

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Read the Settings tab into a plain object keyed by the Key column.
 * Always read live — payment/admin details must never be hardcoded.
 */
export async function getSettings() {
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
}

// ─── Products (catalog only — no stock, no credentials) ──────────────────────

/**
 * Read the Products tab. Returns active products only, each as
 * { id, name, variant, type, price, description, active }.
 */
export async function getProducts() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Products!A2:G",
  });
  const rows = res.data.values || [];
  return rows
    .filter((row) => row[0]) // must have a Product ID
    .map((row) => ({
      id: (row[0] || "").trim(),
      name: (row[1] || "").trim(),
      variant: (row[2] || "").trim(),
      type: (row[3] || "").toLowerCase().trim(), // "ready" | "email"
      price: (row[4] || "0").toString().trim(),
      description: row[5] || "",
      active: (row[6] || "").trim(),
    }))
    .filter((p) => p.active.toLowerCase() !== "no");
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
async function getInventory() {
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

/** First Available Inventory row for a product, or null if sold out. */
export async function getAvailableInventory(productId) {
  const inv = await getInventory();
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
}

// ─── Orders ──────────────────────────────────────────────────────────────────

/** Next auto-increment Order ID, e.g. "ORD-0001". */
async function nextOrderId() {
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
  return `ORD-${String(max + 1).padStart(4, "0")}`;
}

/**
 * Create a new order row in "Awaiting Payslip" state and return the Order ID.
 * Only the fields known at purchase time are filled; the rest stay blank until
 * payslip / admin / delivery steps update them.
 */
export async function createOrder({
  customerUsername,
  customerChatId,
  productId,
  productName,
  variant,
  price,
}) {
  const orderId = await nextOrderId();
  const row = [
    orderId, // A Order ID
    now(), // B Date Created
    customerUsername, // C Customer Username
    customerChatId, // D Customer Chat ID
    productId, // E Product ID
    productName, // F Product Name
    variant, // G Variant
    price, // H Price (MMK)
    "Awaiting Payslip", // I Payment Status
    "No", // J Payslip Sent
    "Pending", // K Admin Decision
    "", // L Decision Time
    "Not Delivered", // M Delivery Status
    "", // N Inventory ID Used
    "", // O Credentials Sent
    "", // P Used Date/Time
    "", // Q Notes
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Orders!A:Q",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  return orderId;
}

/** Find an order by Order ID. Returns an object with rowNumber, or null. */
export async function getOrderByOrderId(orderId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Orders!A2:Q",
  });
  const rows = res.data.values || [];
  const i = rows.findIndex((r) => (r[0] || "").trim() === orderId);
  if (i === -1) return null;
  const r = rows[i];
  return {
    rowNumber: i + 2,
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
  };
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
