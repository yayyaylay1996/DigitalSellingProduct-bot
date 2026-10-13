/**
 * What the staff order flow offers, read from the Order Desk itself so it can
 * never drift from what the Desk accepts:
 *
 *   Config tab  → Items, Sources, Access and Duration values (only Active ones)
 *   Prices tab  → Item | Access | Duration | Price, the list price for each plan
 *
 * Every value written to the Desk must be spelled exactly as in Config ("1Month",
 * not "1 Month"), otherwise the row silently drops out of the Desk's reports. So
 * price-list rows are matched to Config values ignoring case and spaces, and
 * written with the Config spelling. Price rows naming an Item that is not an
 * Active Config item are left out (and reported), never guessed.
 *
 * buildCatalog() is pure and tested; loadCatalog() reads the two tabs.
 */
import { deskSheets, deskEnabled, DESK_SHEET } from "./desk.js";
import { DEFAULT_SOURCES, DEFAULT_PAYMENTS } from "./order-flow-lib.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(String(v ?? "").trim());

function headerIndex(header, name, fallback) {
  const i = (header || []).findIndex((h) => String(h ?? "").trim().toLowerCase() === name);
  return i >= 0 ? i : fallback;
}

function unique(list) {
  const seen = new Set();
  return list.filter((v) => {
    const k = norm(v);
    if (!v || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * @param configValues rows of the Config tab, header first
 * @param priceValues  rows of the Prices tab, header first
 * @param payments     payment methods to offer (not stored in the Desk)
 */
export function buildCatalog(configValues = [], priceValues = [], payments = DEFAULT_PAYMENTS) {
  const [ch, ...cRows] = configValues;
  const iList = headerIndex(ch, "list", 0);
  const iVal = headerIndex(ch, "value", 1);
  const iEmail = headerIndex(ch, "needs email", 2);
  const iActive = headerIndex(ch, "active", 4);
  const iRemind = headerIndex(ch, "reminder", 5);
  const iTrack = headerIndex(ch, "track", 6);

  // Blank Active counts as active (same rule as the Desk's own reminder script).
  const active = (r) => String(r[iActive] ?? "").trim() === "" || truthy(r[iActive]);
  const values = (list) =>
    unique(
      cRows
        .filter((r) => String(r[iList] ?? "").trim() === list && active(r))
        .map((r) => String(r[iVal] ?? "").trim())
    );

  const itemRows = [];
  const seenItems = new Set();
  for (const r of cRows) {
    if (String(r[iList] ?? "").trim() !== "Item" || !active(r)) continue;
    const name = String(r[iVal] ?? "").trim();
    if (!name || seenItems.has(norm(name))) continue;
    seenItems.add(norm(name));
    itemRows.push({
      name,
      needsEmail: truthy(r[iEmail]),
      reminder: truthy(r[iRemind]),
      track: truthy(r[iTrack]),
    });
  }

  const sources = values("Source");
  const accesses = values("Access");
  const durations = values("Duration");
  const canon = (arr) => new Map(arr.map((v) => [norm(v), v]));
  const itemC = canon(itemRows.map((i) => i.name));
  const accessC = canon(accesses);
  const durationC = canon(durations);

  const [ph, ...pRows] = priceValues;
  const pItem = headerIndex(ph, "item", 0);
  const pAcc = headerIndex(ph, "access", 1);
  const pDur = headerIndex(ph, "duration", 2);
  const pPrice = headerIndex(ph, "price", 3);

  const options = {};
  const unknownItems = new Set();
  let skippedRows = 0;
  for (const r of pRows) {
    const rawItem = String(r[pItem] ?? "").trim();
    if (!rawItem) continue;
    const item = itemC.get(norm(rawItem));
    if (!item) {
      unknownItems.add(rawItem);
      continue;
    }
    const access = accessC.get(norm(r[pAcc]));
    const duration = durationC.get(norm(r[pDur]));
    const price = Number(String(r[pPrice] ?? "").replace(/[^\d.]/g, ""));
    if (!access || !duration || !(price > 0)) {
      skippedRows++;
      continue;
    }
    const list = (options[item] ||= []);
    if (!list.some((o) => o.access === access && o.duration === duration)) list.push({ access, duration, price });
  }

  return {
    items: itemRows,
    sources: sources.length ? sources : DEFAULT_SOURCES,
    accesses,
    durations,
    payments: payments.length ? payments : DEFAULT_PAYMENTS,
    options,
    warnings: {
      unknownItems: [...unknownItems].sort(),
      skippedRows,
      itemsWithoutPrices: itemRows.filter((i) => !options[i.name]?.length).map((i) => i.name),
    },
  };
}

/** Payment methods: STAFF_PAYMENTS="KPay,Wave,…" or the built-in list. */
export function paymentList(env = process.env.STAFF_PAYMENTS) {
  const l = unique(String(env || "").split(/[,\n;]/).map((s) => s.trim()));
  return l.length ? l : DEFAULT_PAYMENTS;
}

let cache = { at: 0, value: null };
const TTL_MS = 5 * 60 * 1000;

/** Read Config + Prices from the Desk (cached 5 minutes). Throws if the Desk can't be read. */
export async function loadCatalog({ force = false } = {}) {
  if (!deskEnabled()) throw new Error("DESK_SHEET_ID not set");
  if (!force && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const res = await deskSheets().spreadsheets.values.batchGet({
    spreadsheetId: DESK_SHEET(),
    ranges: ["Config!A1:G", "Prices!A1:D"],
  });
  const [config, prices] = res.data.valueRanges.map((v) => v.values || []);
  const value = buildCatalog(config, prices, paymentList());
  if (!value.items.length) throw new Error("Config has no active Items");
  cache = { at: Date.now(), value };
  return value;
}
