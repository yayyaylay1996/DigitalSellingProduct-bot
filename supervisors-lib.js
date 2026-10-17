/**
 * Supervisors in the SHOP bot — people who may press ✅ Verify / ❌ No Verify on a
 * customer's ORDER payslip, besides the admin. Pure helpers (tested); index.js wires them in.
 *
 * Rules, chosen to be conservative:
 *  - Who: numeric Telegram IDs in SUPERVISOR_CHAT_IDS (comma list). Never @usernames — a
 *    username can be released and re-registered by someone else.
 *  - Where: a private chat with the bot only (so the buttons can't be used from a group).
 *  - What: order payslips only. Wallet top-ups stay admin-only (they credit money and need
 *    the amount typed in).
 *  - ❌ No Verify: always allowed.
 *  - ✅ Verify: only when the slip check gave 🟢 or 🟡. On 🔴 (e.g. duplicate slip), or when
 *    there is no verdict (checker off / too slow / error), the supervisor must leave it
 *    to the admin.
 *  - Everything that needs real follow-up (manual set-up cards, out-of-stock, Desk errors)
 *    still goes to the admin, not the supervisor.
 */

/** "123, 456 ,abc,789" → { ids: ["123","456","789"], ignored: ["abc"] } */
export function parseSupervisorIds(raw) {
  const ids = [];
  const ignored = [];
  for (const part of String(raw ?? "").split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (/^\d{5,15}$/.test(t)) {
      if (!ids.includes(t)) ids.push(t);
    } else {
      ignored.push(t);
    }
  }
  return { ids, ignored };
}

/** "admin" | "supervisor" | null for whoever pressed a button. */
export function roleFor({ chatId, chatType, adminId, supervisorIds }) {
  const id = String(chatId ?? "");
  if (adminId && id === String(adminId)) return "admin";
  if (chatType === "private" && id && (supervisorIds || []).includes(id)) return "supervisor";
  return null;
}

/** Slip-check levels a supervisor may Verify: 🟢 "ok" and 🟡 "warn". */
export const SUPERVISOR_VERIFY_LEVELS = ["ok", "warn"];

/** May this role Verify (✅) an order whose slip check gave `level`? */
export function canVerify(role, level) {
  if (role === "admin") return true;
  return role === "supervisor" && SUPERVISOR_VERIFY_LEVELS.includes(level);
}

/** A readable name for the person who pressed: "Aye (@aye) · 12345". */
export function actorName(from) {
  if (!from) return "?";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  const handle = from.username ? `@${from.username}` : "";
  return [name || handle || "?", name && handle ? `(${handle})` : ""].filter(Boolean).join(" ");
}

/** Text for the sheet's "Admin Decision" cell and the status line under the buttons. */
export function decisionLabel(action, role, from) {
  const base = action === "verify" ? "Verified" : "No Verify";
  if (role !== "supervisor") return base;
  return `${base} (by ${actorName(from)})`;
}

/** SLIP_GROUP_ID must be a negative numeric chat id ("-1001234567890"); anything else → "" (off). */
export function parseGroupId(raw) {
  const t = String(raw ?? "").trim();
  return /^-\d{5,20}$/.test(t) ? t : "";
}

/**
 * Who a button press counts as inside the payslip GROUP. In a group the chat id is the group's, so
 * the person is identified by their own Telegram user id, and only the admin counts. Everyone else
 * in the group (staff, supervisors) can see the card but not decide.
 */
export function groupRoleFor({ fromId, adminId }) {
  return adminId && fromId != null && String(fromId) === String(adminId) ? "admin" : null;
}
