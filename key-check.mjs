// Is the slip checker's key alive?   node key-check.mjs        → credit & expiry of the main key
//                                    node key-check.mjs --ping → also sends one tiny test request to EACH key
// Run this after putting a NEW key in .env. The keys themselves are never printed.
import "dotenv/config";
import { keyHealth, keyWarning, slipProviders } from "./slipcheck.js";

const provs = slipProviders();
if (!provs.length) { console.error("No ANTHROPIC_API_KEY or SLIP_API_KEY in .env."); process.exit(1); }
provs.forEach((p, i) => console.log(`${i === 0 ? "Main  " : "Backup"}: ${p.name}\n        ${p.baseUrl}  model ${p.model}  key …${p.apiKey.slice(-4)} (${p.apiKey.length} characters)  expires ${p.expires || "not set"}`));

const h = await keyHealth();
console.log(`\nMain key — expires: ${h.expiresAt ? new Date(h.expiresAt).toISOString().slice(0, 10) : "unknown"}   credit left: ${h.remainingUsd == null ? "unknown" : "$" + h.remainingUsd.toFixed(2)}   (from: ${h.source})`);
const w = keyWarning(h);
console.log(w ? "⚠️  " + w.text : "✅ Nothing to worry about yet.");

if (process.argv.includes("--ping")) {
  let allOk = true;
  for (const p of provs) {
    try {
      const res = await fetch(`${p.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: p.model, max_tokens: 8, messages: [{ role: "user", content: "Say OK." }] }),
        signal: AbortSignal.timeout(40000),
      });
      console.log(res.ok ? `✅ ${p.name}: test request worked.` : `❌ ${p.name}: test request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      if (!res.ok) allOk = false;
    } catch (e) {
      console.log(`❌ ${p.name}: ${e.message}`);
      allOk = false;
    }
  }
  process.exit(allOk ? 0 : 1);
}
