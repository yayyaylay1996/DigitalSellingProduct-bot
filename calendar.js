/**
 * Create the 14-day Zoom reminder series on Google Calendar, from the bot.
 *
 * WHY THE BOT AND NOT THE APPS SCRIPT
 * The Desk builds its reminder inside the order form, where the staff member
 * has already typed the customer's email. The bot can't do that at checkout —
 * it has to ask the customer and wait for a reply. The moment that email
 * arrives is the first moment everything needed exists, so that's when this
 * runs. The Apps Script trigger stays in place as a safety net for anything
 * that fails here.
 *
 * SETUP (one-off, and it will not work without this)
 *   Google Calendar → Settings → the calendar → "Share with specific people"
 *   → add the service account address with "Make changes to events":
 *       sheet-bot-access@digital-shop-bot.iam.gserviceaccount.com
 *   A service account is not a person: nothing arrives by email, it simply
 *   gains write access.
 *
 * These values mirror REMIND_HOUR / REMIND_EVERY_DAYS / TZ_MM in the Desk's
 * Code.gs. They are duplicated across two systems, so changing one means
 * changing the other — see REMINDER_SETTINGS below.
 */
import "dotenv/config";
import { google } from "googleapis";

/** Must stay in step with Code.gs in the Apps Script project. */
export const REMINDER_SETTINGS = {
  hour: "08:00", // REMIND_HOUR
  everyDays: 14, // REMIND_EVERY_DAYS
  timeZone: "Asia/Yangon", // TZ_MM
  utcOffsetMinutes: 390, // Asia/Yangon is UTC+6:30 and has no daylight saving
  popupMinutesBefore: 30,
  durationMinutes: 30,
};

const CALENDAR_ID = process.env.REMINDER_CALENDAR_ID || "";

let calendarClient = null;
function client() {
  if (calendarClient) return calendarClient;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || "")
        .replace(/^["']|["']$/g, "")
        .replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

export function calendarEnabled() {
  return Boolean(CALENDAR_ID);
}

/** "2026-08-07 18:42" or "2026-08-07" → "2026-08-07". */
function dateOnly(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** Local wall-clock in Myanmar → the RFC5545 UTC stamp RRULE UNTIL needs.
 *  23:59 in Yangon is 17:29 UTC the same day; getting this wrong would end
 *  the series a day early or late. */
function toUntilUtc(dateStr, hhmm) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const utc = new Date(Date.UTC(y, mo - 1, d, hh, mm) - REMINDER_SETTINGS.utcOffsetMinutes * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${utc.getUTCFullYear()}${p(utc.getUTCMonth() + 1)}${p(utc.getUTCDate())}T` +
    `${p(utc.getUTCHours())}${p(utc.getUTCMinutes())}${p(utc.getUTCSeconds())}Z`
  );
}

function endTime(hhmm, addMinutes) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const total = hh * 60 + mm + addMinutes;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 60) % 24)}:${p(total % 60)}`;
}

/**
 * Create the recurring reminder. Never throws — returns a result the caller
 * can report, because a calendar problem must not disturb a paid customer.
 *
 * `order` – { no, customer, item, duration, email, source, startDate, expiry }
 */
export async function createZoomReminder(order) {
  if (!calendarEnabled()) return { ok: false, skipped: "REMINDER_CALENDAR_ID not set" };

  const start = dateOnly(order.startDate);
  const until = dateOnly(order.expiry);
  if (!start || !until) return { ok: false, skipped: "missing start or expiry date" };
  if (until <= start) return { ok: false, skipped: "plan ends before the first reminder" };

  const { hour, everyDays, timeZone, popupMinutesBefore, durationMinutes } = REMINDER_SETTINGS;

  try {
    const res = await client().events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${order.item} — ${order.customer}`,
        description: [
          `Order No. ${order.no}`,
          `Customer: ${order.customer}`,
          `Email: ${order.email || "—"}`,
          `Source: ${order.source || "—"}`,
          `Plan: ${order.item} · ${order.duration}`,
          `Runs until: ${until}`,
        ].join("\n"),
        start: { dateTime: `${start}T${hour}:00`, timeZone },
        end: { dateTime: `${start}T${endTime(hour, durationMinutes)}:00`, timeZone },
        recurrence: [
          `RRULE:FREQ=WEEKLY;INTERVAL=${everyDays / 7};UNTIL=${toUntilUtc(until, "23:59")}`,
        ],
        reminders: {
          useDefault: false,
          overrides: [{ method: "popup", minutes: popupMinutesBefore }],
        },
      },
    });
    return { ok: true, eventId: res.data.id, htmlLink: res.data.htmlLink };
  } catch (e) {
    console.error("createZoomReminder:", e.message);
    return { ok: false, error: e.message };
  }
}
