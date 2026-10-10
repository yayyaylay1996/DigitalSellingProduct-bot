// Reads the QR code printed on a payment slip. The QR carries the transaction
// number exactly as the bank issued it, so it is far more reliable than reading
// a 20-digit number off a picture (the AI reader misreads digits fairly often).
//
//  • KBZPay e-receipts:  KPRSC.<base64url JSON {tid, ts, ...}>.<signature>
//      tid = transaction number, ts = time in milliseconds (UTC).
//  • Thai bank slips (Krungthai, KBank, SCB…): the standard "slip verify" QR —
//      an EMV-style TLV string whose tag 00 holds the sending-bank code and the
//      bank's transaction reference. It carries a CRC, which we check.
//
// Nothing here can prove a slip is genuine (we can't check the bank's signature);
// it only gives an exact number and time to compare against the printed ones.
// The image libraries are loaded lazily so the pure parsing is testable alone.

const THAI_BANKS = {
  "002": "Bangkok Bank", "004": "KBank", "006": "Krungthai", "011": "TTB",
  "014": "SCB", "025": "Krungsri", "030": "GSB", "069": "KKP",
};

/** CRC-16/CCITT-FALSE, as used by EMV / Thai QR payloads. */
export function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(str) {
  const out = [];
  let i = 0;
  while (i + 4 <= str.length) {
    const tag = str.slice(i, i + 2);
    const len = Number(str.slice(i + 2, i + 4));
    if (!Number.isInteger(len) || len < 0 || i + 4 + len > str.length) return null;
    out.push({ tag, value: str.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return i === str.length ? out : null;
}

/** Text of a decoded QR → { kind, txnId, tsMs?, bank? } or null if it isn't a slip QR. */
export function parseSlipQr(text) {
  const s = String(text || "").trim();

  if (s.startsWith("KPRSC.")) {
    try {
      let p = s.split(".")[1] || "";
      p = p.replace(/-/g, "+").replace(/_/g, "/");
      p += "=".repeat((4 - (p.length % 4)) % 4);
      const j = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
      const tid = String(j.tid || "").replace(/\D/g, "");
      if (tid.length < 12) return null;
      const ts = Number(j.ts);
      const ok = Number.isFinite(ts) && ts > Date.UTC(2020, 0, 1) && ts < Date.UTC(2100, 0, 1);
      return { kind: "kbzpay", txnId: tid, tsMs: ok ? ts : null };
    } catch {
      return null;
    }
  }

  // Thai slip-verify QR: ...[91 04 CRC] at the end.
  if (/^\d{4}/.test(s) && /9104[0-9A-Fa-f]{4}$/.test(s)) {
    const body = s.slice(0, -4);
    if (crc16(body).toUpperCase() !== s.slice(-4).toUpperCase()) return null; // damaged read
    const top = tlv(s);
    const t00 = top?.find((x) => x.tag === "00");
    const inner = t00 && tlv(t00.value);
    const code = inner?.find((x) => x.tag === "01")?.value || "";
    const ref = inner?.find((x) => x.tag === "02")?.value || "";
    if (!ref) return null;
    return { kind: "thai", txnId: ref, tsMs: null, bank: THAI_BANKS[code] || code || "" };
  }
  return null;
}

/** Try the picture at a few sizes (phone photos need upscaling). Returns the QR's text or null. */
export async function decodeQrText(imageBuffer) {
  const { Jimp } = await import("jimp");
  const jsQR = (await import("jsqr")).default;
  const img = await Jimp.read(imageBuffer);
  for (const w of [null, 1000, 1600]) {
    const im = img.clone();
    if (w) {
      if (im.bitmap.width >= w) continue;
      im.resize({ w });
    }
    const { data, width, height } = im.bitmap;
    const r = jsQR(new Uint8ClampedArray(data), width, height, { inversionAttempts: "attemptBoth" });
    if (r?.data) return r.data;
  }
  return null;
}

/** Picture → parsed slip QR, or null. Never throws. */
export async function readSlipQr(imageBuffer) {
  try {
    const text = await decodeQrText(imageBuffer);
    return text ? parseSlipQr(text) : null;
  } catch (e) {
    console.warn("slip QR read failed:", e.message);
    return null;
  }
}
