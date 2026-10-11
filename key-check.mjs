// Is the slip checker's key alive?   node key-check.mjs        → credit & expiry of the main key
//                                    node key-check.mjs --ping → also sends one tiny test request to EACH key
// Run this after putting a NEW key in .env. The keys themselves are never printed.
import "dotenv/config";
import { keyHealth, keyWarning, slipProviders } from "./slipcheck.js";

import fs from "node:fs";
// dotenv never overrides a variable the Terminal already has. If it does, the .env value is silently ignored.
try {
  const file = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const name of ["ANTHROPIC_API_KEY", "SLIP_API_KEY"]) {
    const m = file.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m"));
    const inFile = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    const live = process.env[name] || "";
    if (inFile && live && inFile !== live)
      console.log(`⚠️  Your Terminal has its own ${name} (…${live.slice(-4)}, ${live.length} characters) that overrides the one in .env (…${inFile.slice(-4)}, ${inFile.length} characters). Run:  unset ${name}   and try again. (Railway is not affected.)\n`);
  }
} catch {}

const provs = slipProviders();
if (!provs.length) { console.error("No ANTHROPIC_API_KEY or SLIP_API_KEY in .env."); process.exit(1); }
provs.forEach((p, i) => console.log(`${i === 0 ? "Main  " : "Backup"}: ${p.name}\n        ${p.baseUrl}  model ${p.model}  key …${p.apiKey.slice(-4)} (${p.apiKey.length} characters)  expires ${p.expires || "not set"}`));

// Common slips, caught before they cost an evening
for (const p of provs) {
  const official = /api\.anthropic\.com/.test(p.baseUrl);
  if (official && (!p.apiKey.startsWith("sk-ant-") || p.apiKey.length < 80))
    console.log(`\n⚠️  ${p.name}: an Anthropic key starts with "sk-ant-" and is about 100+ characters long. This one is ${p.apiKey.length} characters — it was probably cut off when copied. Create a new key and use the Copy button.`);
  if (p.expires && !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(p.expires))
    console.log(`\n⚠️  ${p.name}: the expiry date "${p.expires}" must be written YEAR-MONTH-DAY, e.g. 2028-05-31, or the reminder is ignored.`);
}

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
