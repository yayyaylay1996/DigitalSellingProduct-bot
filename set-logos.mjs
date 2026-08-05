/**
 * Fill the Products "Logo" column with each product's logo filename, matched by
 * Product Name. Header-aware: it finds the Logo column, or appends one if it
 * doesn't exist. Safe to re-run. Run locally:  node set-logos.mjs
 *
 * The filenames below must match the files in webapp/logos/.
 */
import "dotenv/config";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credentials = JSON.parse(
  fs.readFileSync(path.join(__dirname, "digital-shop-bot-e817e6e12e92.json"), "utf-8")
);
const spreadsheetId = process.env.GOOGLE_SHEET_ID;
if (!spreadsheetId) { console.error("Missing GOOGLE_SHEET_ID in .env"); process.exit(1); }
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Product Name → logo filename (must exist in webapp/logos/)
const LOGO = {
  "Capcut Pro": "capcut.png",
  "Netflix": "netflix.jpg",
  "Amazon Prime": "amazon-prime.png",
  "YouTube Premium": "youtube-premium.jpeg",
  "Outline VPN - Phone": "outline-vpn.jpeg",
  "Outline VPN - Computer": "outline-vpn.jpeg",
  "Gemini": "gemini.jpeg",
  "Canva": "canva.jpeg",
  "Spotify": "spotify.jpeg",
  "Telegram Premium": "telegram.jpeg",
  "ChatGPT Plus": "chatgpt.png",
  "Quillbot Premium": "quillbot.jpeg",
  "Claude AI": "claude.png",
  "Meitu (SVIP)": "meitu.jpeg",
  "Perplexity Pro": "perplexity.png",
  "Zoom Pro": "zoom.png",
  "Super Gork Ai": "super-grok.png",
};

function colLetter(idx) {
  let s = "";
  idx += 1;
  while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

async function main() {
  const values =
    (await sheets.spreadsheets.values.get({ spreadsheetId, range: "Products!A1:Z" })).data.values || [];
  if (values.length === 0) { console.log("No Products data."); return; }

  const headers = values[0].map((h) => (h || "").trim().toLowerCase());
  const nameIdx = headers.findIndex((h) => h === "product name" || h.includes("product name") || h === "name");
  if (nameIdx === -1) { console.error('Could not find a "Product Name" column.'); process.exit(1); }

  let logoIdx = headers.findIndex((h) => h === "logo");
  if (logoIdx === -1) logoIdx = values[0].length; // append a new column at the end

  const out = [["Logo"]];
  let changed = 0;
  const unknown = new Set();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const name = (row[nameIdx] || "").trim();
    const existing = row[logoIdx] || "";
    if (name && LOGO[name]) { out.push([LOGO[name]]); changed++; }
    else { if (name) unknown.add(name); out.push([existing]); }
  }

  const L = colLetter(logoIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Products!${L}1:${L}${out.length}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: out },
  });

  console.log(`✔ Wrote logo filenames to column ${L} for ${changed} row(s).`);
  if (unknown.size) console.log("• No logo mapped for:", [...unknown].join(", "));
  console.log("\nNext: re-deploy the webapp folder to Netlify, then open the Shop button.");
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
