// Is the slow/hanging reader our code or the provider?   node diag-reader.mjs
// Sends 6 tiny text-only requests, then 6 slip-image requests (no QR work at all),
// one at a time, and prints how long each took. The key is never printed.
import "dotenv/config";
import fs from "fs";
import path from "path";

const key = process.env.SLIP_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const base = (process.env.SLIP_API_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "");
const model = process.env.SLIP_MODEL || "claude-haiku-4-5";
if (!key) { console.error("No SLIP_API_KEY in .env"); process.exit(1); }
console.log(`Provider ${base}  model ${model}\n`);

async function call(content, label) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content }] }),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${label.padEnd(28)} ${res.ok ? "ok" : "HTTP " + res.status}  ${secs}s`);
  } catch (e) {
    console.log(`${label.padEnd(28)} ${e.name === "TimeoutError" ? "TIMED OUT (25s)" : e.message}`);
  }
}

for (let i = 1; i <= 6; i++) await call("Say OK.", `text-only #${i}`);

const dir = "Pay Slip samples";
const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().slice(0, 6);
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const type = /\.png$/i.test(f) ? "image/png" : "image/jpeg";
  await call(
    [{ type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } }, { type: "text", text: "What app is this? One word." }],
    `image ${f.slice(0, 18)}`
  );
}
