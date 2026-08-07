/**
 * Why aren't bot orders showing up on the Order Desk?
 *
 *   node desk-doctor.mjs
 *
 * Checks every link in the chain in order and stops at the first broken one,
 * because a later check failing is usually just a symptom of an earlier one.
 * Read-only.
 */
import "dotenv/config";
import { google } from "googleapis";

const BOT_ID = process.env.GOOGLE_SHEET_ID;
const DESK_ID = process.env.DESK_SHEET_ID || "";

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m, fix) => {
  console.log(`  ✗ ${m}`);
  if (fix) console.log(`     → ${fix}`);
};

let failed = false;
const step = (n, title) => console.log(`\n${n}. ${title}`);

console.log("Order Desk sync — diagnostic\n" + "═".repeat(40));

// 1 ─────────────────────────────────────────────────────────────────────────
step(1, "DESK_SHEET_ID set locally?");
if (!DESK_ID) {
  bad("not set in .env", "add DESK_SHEET_ID=... to .env (see .env.example)");
  failed = true;
} else {
  ok(DESK_ID);
}

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
const get = async (id, range) =>
  (await sheets.spreadsheets.values.get({ spreadsheetId: id, range })).data.values || [];

// 2 ─────────────────────────────────────────────────────────────────────────
if (!failed) {
  step(2, "Can the bot open the Desk sheet?");
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: DESK_ID,
      fields: "properties.title",
    });
    ok(`"${meta.data.properties.title}"`);
  } catch (e) {
    bad(
      e.message,
      `share the Desk sheet with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor`
    );
    failed = true;
  }
}

// 3 ─────────────────────────────────────────────────────────────────────────
let mapped = 0;
if (!failed) {
  step(3, 'Does the bot\'s Products sheet have a filled "Desk Item" column?');
  const products = await get(BOT_ID, "Products!A1:Z");
  const headers = (products[0] || []).map((h) => String(h || "").trim().toLowerCase());
  const iDesk = headers.indexOf("desk item");
  const iName = headers.indexOf("product name") !== -1
    ? headers.indexOf("product name")
    : headers.indexOf("name");

  if (iDesk === -1) {
    bad('no "Desk Item" column', "run: node desk-setup.mjs --write");
    failed = true;
  } else {
    const rows = products.slice(1).filter((r) => String(r[iName] || "").trim());
    mapped = rows.filter((r) => String(r[iDesk] || "").trim()).length;
    const blank = rows.length - mapped;
    if (mapped === 0) {
      bad(`column exists but all ${rows.length} rows are blank`, "run: node desk-setup.mjs --write");
      failed = true;
    } else {
      ok(`${mapped} of ${rows.length} products mapped`);
      if (blank) {
        console.log(`     ${blank} blank — those products are skipped on purpose:`);
        for (const r of rows.filter((r) => !String(r[iDesk] || "").trim()).slice(0, 8)) {
          console.log(`       ${String(r[iName]).trim()}`);
        }
      }
    }
  }
}

// 4 ─────────────────────────────────────────────────────────────────────────
if (!failed) {
  step(4, "Has the bot recorded any sales of its own?");
  const orders = await get(BOT_ID, "Orders!A2:R");
  const rows = orders.filter((r) => String(r[0] || "").trim());
  if (rows.length === 0) {
    bad(
      "the bot's Orders tab is empty — no completed sale has happened yet",
      "make one test purchase and finish it (admin taps Verified, or pay by wallet)"
    );
    failed = true;
  } else {
    ok(`${rows.length} order(s); newest: ${rows[rows.length - 1][0]} ${rows[rows.length - 1][1]}`);
  }
}

// 5 ─────────────────────────────────────────────────────────────────────────
if (!failed) {
  step(5, "Have any of them reached the Desk?");
  const desk = await get(DESK_ID, "Orders!A2:T");
  const fromBot = desk.filter((r) => String(r[7] || "").trim().toLowerCase() === "bot");
  const viaTg = desk.filter((r) => String(r[5] || "").trim() === "G-Tg");

  console.log(`     Desk has ${desk.length} row(s); ${viaTg.length} marked Source G-Tg`);
  if (fromBot.length === 0) {
    bad(
      'no rows with Seller Name "Bot"',
      "the bot has not written any row yet — most often DESK_SHEET_ID is missing " +
        "on Railway, or the running deploy predates the desk sync"
    );
  } else {
    ok(`${fromBot.length} row(s) written by the bot`);
    const last = fromBot[fromBot.length - 1];
    console.log(
      `     latest: No.${last[0]} ${last[1]} ${last[2]} · ${last[6]} · ${last[12]} · expires ${last[16]}`
    );
  }
}

console.log("\n" + "═".repeat(40));
console.log(
  failed
    ? "Fix the ✗ above, then run this again."
    : "Chain looks healthy. If rows still aren't appearing, check Railway:\n" +
      "  • Variables tab has DESK_SHEET_ID\n" +
      "  • the newest deployment includes the desk sync commit"
);
