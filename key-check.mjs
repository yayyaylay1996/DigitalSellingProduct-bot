// Is the slip checker's key alive?   node key-check.mjs        → credit & expiry
//                                    node key-check.mjs --ping → also sends one tiny test request
// Run this after putting a NEW key in .env. The key itself is never printed.
import "dotenv/config";
import { keyHealth, keyWarning } from "./slipcheck.js";

const key = process.env.SLIP_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const base = (process.env.SLIP_API_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "");
if (!key) { console.error("No SLIP_API_KEY in .env."); process.exit(1); }
console.log(`Provider: ${base}\nKey: …${key.slice(-4)} (${key.length} characters)\nModel: ${process.env.SLIP_MODEL || "claude-haiku-4-5"}`);

const h = await keyHealth();
console.log(`Expires: ${h.expiresAt ? new Date(h.expiresAt).toISOString().slice(0, 10) : "unknown"}   Credit left: ${h.remainingUsd == null ? "unknown" : "$" + h.remainingUsd.toFixed(2)}   (from: ${h.source})`);
const w = keyWarning(h);
console.log(w ? "⚠️  " + w.text : "✅ Nothing to worry about yet.");

if (process.argv.includes("--ping")) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.SLIP_MODEL || "claude-haiku-4-5", max_tokens: 8, messages: [{ role: "user", content: "Say OK." }] }),
  });
  console.log(res.ok ? "✅ Test request worked." : `❌ Test request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(res.ok ? 0 : 1);
}
