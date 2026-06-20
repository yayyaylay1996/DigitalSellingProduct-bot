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

/**
 * Read all products from the "Products" tab.
 * Returns an array of { name, type, price, stock } objects.
 * Skips rows with no name (handles trailing empty rows).
 */
export async function getProducts() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Products!A2:D", // skip header row
  });

  const rows = res.data.values || [];
  return rows
    .filter((row) => row[0]) // must have a name
    .map((row) => {
      const rawStock = (row[3] || "").trim();
      return {
        name: row[0],
        type: (row[1] || "").toLowerCase().trim(),
        price: row[2] || "0",
        // "-" means unlimited (email products); otherwise parse as int
        stock: rawStock === "-" ? Infinity : parseInt(rawStock || "0", 10),
      };
    });
}

/**
 * Append a new order row to the "Orders" tab.
 * Columns: Date | Customer ID | Product | Email | Status
 */
export async function logOrder({ customerId, product, email = "" }) {
  const now = new Date();
  const date = now.toISOString().slice(0, 16).replace("T", " "); // "YYYY-MM-DD HH:MM"
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Orders!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[date, customerId, product, email, "Pending"]],
    },
  });
}

/**
 * Decrease the stock count for a product by 1.
 * Finds the product by name in column A and decrements column D.
 */
export async function decreaseStock(productName) {
  // Read all rows to find the matching row number
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Products!A2:D",
  });

  const rows = res.data.values || [];
  const rowIndex = rows.findIndex((row) => row[0] === productName);

  if (rowIndex === -1) {
    throw new Error(`Product "${productName}" not found in sheet`);
  }

  const rawStock = (rows[rowIndex][3] || "").trim();

  // "-" means unlimited (email products) — nothing to decrement
  if (rawStock === "-") return;

  const currentStock = parseInt(rawStock || "0", 10);
  if (currentStock <= 0) {
    throw new Error(`Product "${productName}" is out of stock`);
  }

  // Row index is 0-based from A2, so actual sheet row = rowIndex + 2
  const sheetRow = rowIndex + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Products!D${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[currentStock - 1]],
    },
  });
}
