// Try the slip reader on real screenshots, without starting the bot:
//   node try-slip.mjs "Pay Slip samples"          (a whole folder, one line per slip)
//   node try-slip.mjs slip-samples/kpay-1.jpg 12000   (one file, full detail; 2nd arg = expected amount)
// Needs SLIP_API_KEY (or ANTHROPIC_API_KEY) in .env. Does not touch Google Sheets.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { readSlip, evaluateSlip, parseReceivers, applyQr, fpKeyOf } from "./slipcheck.js";
import { readSlipQr } from "./slipqr.js";

const [target, expected] = process.argv.slice(2);
if (!target) {
  console.error('Usage: node try-slip.mjs <image or folder> [expectedAmount]');
  process.exit(1);
}
if (!(process.env.SLIP_API_KEY || process.env.ANTHROPIC_API_KEY)) {
  console.error("Set SLIP_API_KEY in .env first.");
  process.exit(1);
}
console.log(`Reader: ${process.env.SLIP_API_BASE_URL || "https://api.anthropic.com"}  model: ${process.env.SLIP_MODEL || "claude-haiku-4-5"}\n`);

const isImg = (f) => /\.(jpe?g|png|webp)$/i.test(f);
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter(isImg).sort().map((f) => path.join(target, f))
  : [target];
const single = files.length === 1;

const mediaOf = (file) => {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
};
const ctxFor = (amt) => ({
  expectedAmount: amt, ref: "TEST", nowMs: Date.now(), priorRows: [], dupCheckFailed: false,
  receivers: parseReceivers(process.env.SLIP_RECEIVERS || ""),
  maxAgeMin: Number(process.env.SLIP_MAX_AGE_MIN || 120),
  defaultOffsetMin: Number(process.env.SLIP_DEFAULT_TZ_OFFSET_MIN || 390),
  thbRate: Number(process.env.SLIP_THB_MMK_RATE || 0),
  rateTolPct: Number(process.env.SLIP_RATE_TOLERANCE_PCT || 3),
});

let ok = 0, failed = 0;
for (const file of files) {
  const t0 = Date.now();
  try {
    const buf = fs.readFileSync(file);
    const [read, qr] = await Promise.all([readSlip(buf, mediaOf(file)), readSlipQr(buf)]);
    const fields = applyQr(read, qr);
    const result = evaluateSlip(fields, ctxFor(expected ? Number(expected) : null));
    ok++;
    if (single) {
      console.log("── What the reader saw ──");
      console.log(JSON.stringify(fields, null, 2));
      console.log("\nTransaction number from: " + fields.txn_source + (fields.reader_transaction_id ? " (the text reader had read " + fields.reader_transaction_id + ")" : "") + "\nFingerprint: " + (fpKeyOf(fields) || "(incomplete)"));
      console.log("\n── What the admin would see (" + result.level + ") ──");
      for (const c of result.checks) console.log(`[${c.status}] ${c.text}`);
    } else {
      const tx = String(fields.transaction_id || "");
      console.log(
        `${path.basename(file).padEnd(32)} ${String(fields.provider || "?").padEnd(8)} ` +
        `${String(fields.amount ?? "?").padStart(8)} ${String(fields.transaction_datetime || "?").padEnd(19)} ` +
        `txn …${tx.slice(-4).padEnd(4)} to ${String(fields.receiver_name || "?").slice(0, 16).padEnd(16)} ` +
        `${String(fields.receiver_account_tail || "").padEnd(5)} ${fields.legibility || ""} ` +
        `${Math.round((Date.now() - t0) / 100) / 10}s ${fields.txn_source === "qr" ? "QR✓" : "no-QR"}${fields.reader_transaction_id ? " (reader had …" + String(fields.reader_transaction_id).slice(-4) + ")" : ""}`
      );
    }
  } catch (e) {
    failed++;
    console.log(`${path.basename(file)}: FAILED after ${Math.round((Date.now() - t0) / 1000)}s — ${e.message}`);
  }
}
console.log(`\nRead ${ok} of ${files.length}${failed ? `, ${failed} failed` : ""}.`);
console.log("(Old sample slips will show 'Old slip' in the admin view — that is expected.)");
