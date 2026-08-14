/**
 * Build railway-env.txt — your .env reformatted for pasting into Railway's
 * Variables → Raw Editor.
 *
 *   node make-railway-env.mjs
 *
 * The only real work here is the private key: hosting dashboards can't store
 * real newlines, so it has to go up as ONE line with literal \n sequences.
 * Getting that wrong is the usual cause of "DECODER routines::unsupported" on
 * a fresh deploy.
 *
 * The output file holds live secrets and is gitignored. Delete it once the
 * variables are saved in Railway.
 */
import fs from "fs";

const raw = fs.readFileSync(".env", "utf8");
const env = {};
for (const line of raw.split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*([\s\S]*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim();
}

let key = (env.GOOGLE_PRIVATE_KEY || "").replace(/^["']|["']$/g, "");
key = key.replace(/\r/g, "").replace(/\n/g, "\\n");
key = `"${key}"`;

const out = [
  "# Paste this whole block into Railway:",
  "#   your service -> Variables tab -> Raw Editor -> paste -> Save",
  "#",
  "# CHECK THE TWO MARKED LINES BEFORE SAVING.",
  "",
  `TELEGRAM_BOT_TOKEN=${env.TELEGRAM_BOT_TOKEN || ""}`,
  `GOOGLE_SHEET_ID=${env.GOOGLE_SHEET_ID || ""}`,
  `GOOGLE_SERVICE_ACCOUNT_EMAIL=${env.GOOGLE_SERVICE_ACCOUNT_EMAIL || ""}`,
  `GOOGLE_PRIVATE_KEY=${key}`,
  "",
  "# CHECK 1 — is this your own Telegram user id? It was copied from",
  "#   TELEGRAM_CHAT_ID in your .env. Confirm with @userinfobot: if it is",
  "#   wrong, payslips and the Confirm/Decline buttons go to the wrong chat.",
  `ADMIN_CHAT_ID=${env.TELEGRAM_CHAT_ID || ""}`,
  "",
  "# CHECK 2 — your .env says Asia/Bangkok (UTC+7), but Myanmar is",
  "#   Asia/Yangon (UTC+6:30). Every order timestamp lands 30 minutes off if",
  "#   this is wrong. Change it unless Bangkok is deliberate.",
  `TZ=${env.TZ || "Asia/Yangon"}`,
  "",
].join("\n");

fs.writeFileSync("railway-env.txt", out);

const singleLine = /\\n/.test(key) && !key.includes("\n");
console.log("✔ wrote railway-env.txt");
console.log(`  private key formatted as a single line with literal \\n: ${singleLine}`);
console.log("  ⚠️  contains live secrets — gitignored; delete it after pasting into Railway.");
