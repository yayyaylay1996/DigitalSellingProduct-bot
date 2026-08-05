/**
 * Fill each product's Icon (emoji) + Category in the Products sheet, matched by
 * Product Name, for ALL of a product's variant rows. Safe to re-run.
 * Edit the MAP below to taste, then:  node set-products-meta.mjs
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
if (!spreadsheetId) {
  console.error("Missing GOOGLE_SHEET_ID in .env");
  process.exit(1);
}
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Product Name → { icon, category }.  Names must match the sheet's column B.
const MAP = {
  "Netflix": { icon: "🎬", category: "Entertainment" },
  "YouTube Premium": { icon: "▶️", category: "Entertainment" },
  "Spotify": { icon: "🎵", category: "Entertainment" },
  "Amazon Prime": { icon: "📺", category: "Entertainment" },

  "ChatGPT Plus": { icon: "🤖", category: "AI Tools" },
  "Claude AI": { icon: "🧠", category: "AI Tools" },
  "Gemini": { icon: "✨", category: "AI Tools" },
  "Perplexity Pro": { icon: "🔎", category: "AI Tools" },
  "Super Gork Ai": { icon: "🤖", category: "AI Tools" },
  "Quillbot Premium": { icon: "✍️", category: "AI Tools" },

  "Capcut Pro": { icon: "🎞️", category: "Creative & Design" },
  "Canva": { icon: "🎨", category: "Creative & Design" },
  "Meitu (SVIP)": { icon: "📸", category: "Creative & Design" },

  "Zoom Pro": { icon: "🎥", category: "Productivity" },
  "Telegram Premium": { icon: "✈️", category: "Productivity" },

  "Outline VPN - Phone": { icon: "🔒", category: "VPN" },
  "Outline VPN - Computer": { icon: "🔒", category: "VPN" },
};

async function main() {
  const names =
    (await sheets.spreadsheets.values.get({ spreadsheetId, range: "Products!B2:B" }))
      .data.values || [];
  const existing =
    (await sheets.spreadsheets.values.get({ spreadsheetId, range: "Products!K2:L" }))
      .data.values || [];

  const out = [];
  let changed = 0;
  const unknown = new Set();
  for (let i = 0; i < names.length; i++) {
    const name = (names[i]?.[0] || "").trim();
    const cur = existing[i] || [];
    if (name && MAP[name]) {
      out.push([MAP[name].icon, MAP[name].category]);
      changed++;
    } else {
      if (name) unknown.add(name);
      out.push([cur[0] || "", cur[1] || ""]); // preserve whatever's there
    }
  }

  if (out.length === 0) {
    console.log("No product rows found.");
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Products!K2:L${out.length + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: out },
  });

  console.log(`✔ Set Icon + Category on ${changed} product row(s).`);
  if (unknown.size) {
    console.log(
      "• Not in MAP (left unchanged) — add them to MAP if you want:\n   " +
        [...unknown].join(", ")
    );
  }
  console.log("\nDone. Restart the bot (npm start) to see the categorized menu.");
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
