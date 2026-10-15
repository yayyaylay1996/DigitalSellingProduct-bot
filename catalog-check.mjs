// What would /order offer right now?  node catalog-check.mjs
// Reads the Order Desk's Config + Prices exactly like the staff bot does. Read-only.
import "dotenv/config";
import { loadCatalog } from "./desk-catalog.js";

console.log("DESK_SHEET_ID set:", Boolean(process.env.DESK_SHEET_ID));
try {
  const c = await loadCatalog({ force: true });
  console.log(`\nSources (${c.sources.length}):`, c.sources.join(", "));
  console.log(`Payments (${c.payments.length}):`, c.payments.join(", "));
  console.log(`Access:`, c.accesses.join(", "), `| Durations:`, c.durations.join(", "));
  console.log(`\nItems (${c.items.length}) — plans with a list price:`);
  for (const i of c.items) {
    const n = c.options[i.name]?.length || 0;
    console.log(`  ${i.name.padEnd(22)} ${n ? n + " plan(s)" : "no prices (typed amount)"}${i.needsEmail ? "  [asks email]" : ""}`);
  }
  console.log("\nPrices ignored because the Item is not an Active Config item:", c.warnings.unknownItems.join(", ") || "none");
  console.log("Price rows skipped (access/duration not in Config, or no price):", c.warnings.skippedRows);
} catch (e) {
  console.error("\nERROR:", e.message);
  process.exitCode = 1;
}
