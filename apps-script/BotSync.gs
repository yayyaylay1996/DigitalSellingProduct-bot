/**
 * Going Forward Premium — reminder catch-up
 *
 * Paste this as a NEW file in the Order Desk's Apps Script project, alongside
 * Code.gs. Do not edit Code.gs; this only reads the sheet and writes the
 * Reminder column.
 *
 * WHY THIS EXISTS
 * The Desk creates its 14-day calendar series inside the order form's save
 * path. Orders that arrive any other way — written by the Telegram bot, or
 * typed straight into the sheet — never pass through that code, so they get
 * no reminder. Nothing runs on a schedule to notice.
 *
 * This runs once a day, finds rows that should have a reminder and don't, and
 * creates it. It doesn't matter how the row got there.
 *
 * WHAT IT DOES NOT DO
 * Nothing is created for items whose Config Reminder flag is off, so the
 * 14-day chase stays limited to Zoom while Track stays on for everything.
 *
 * SETUP
 *   1. Paste this file into the project (＋ → Script → name it BotSync).
 *   2. Run catchUpReminders once by hand and accept the permission prompt.
 *   3. Triggers (clock icon) → Add Trigger:
 *        function: catchUpReminders
 *        event source: Time-driven → Minutes timer → Every 5 minutes
 *
 * WHY EVERY 5 MINUTES RATHER THAN INSTANTLY
 * A Zoom sale can't have its reminder built at the moment of purchase: the
 * bot has to ask the customer for their email first, and the calendar event
 * carries that address. Creating the event at checkout would put "Email: —"
 * on every Zoom reminder — the one field that makes it actionable.
 *
 * So the reminder has to wait for the email, which means polling. Five
 * minutes is indistinguishable from instant for a 14-day cadence, and it
 * needs no Calendar credentials in the bot and no second system able to
 * create events (which would risk duplicates).
 *
 * Writes made by the Sheets API — which is how the bot adds rows — do not
 * fire onEdit or onChange triggers, so a time-driven trigger is the only
 * mechanism available here regardless.
 */

/**
 * Calendar the reminders land on — the same one Code.gs already uses, since
 * it's the script owner's own calendar. Left explicit rather than relying on
 * getDefaultCalendar() so it stays obvious where reminders go, and so pointing
 * them elsewhere later is a one-line change.
 *
 * If this is ever changed to another account's calendar, that calendar must be
 * shared with the script owner with "Make changes to events". The lookup falls
 * back to the default calendar and logs a warning rather than silently
 * dropping every reminder.
 *
 * Reminders fire at REMIND_HOUR (08:00) Myanmar time — see TZ_MM in Code.gs.
 * On a device set to Bangkok time that displays as 08:30, which is the same
 * moment, not a different one.
 */
const REMINDER_CALENDAR_ID = 'yeemonmontin71@gmail.com';

/**
 * Only rows recorded by this seller are touched.
 *
 * This is what keeps YOUR manual control intact. Orders entered through the
 * dashboard already made their reminder decision at save time — if you untick
 * the 14-day box, that must stay unticked. This script never looks at those
 * rows, so it can't undo you. It only fills the gap for orders the bot wrote,
 * which never passed through the form and so were never asked the question.
 */
const CATCHUP_SELLER = 'Bot';

/**
 * And only for a few days after the sale.
 *
 * After this window a row is left alone forever. So if you later untick the
 * reminder on a bot order, tomorrow's run won't put it back — the decision
 * becomes permanently yours. Also stops a first run from flooding the
 * calendar with the whole back catalogue.
 */
const CATCHUP_WINDOW_DAYS = 3;

/** How many rows from the bottom of Orders to examine each run. Comfortably
 *  more than three days of sales, while keeping a 5-minute trigger cheap. */
const SCAN_ROWS = 400;

/** Column F on the Orders tab. Code.gs doesn't name this one, so it's defined
 *  here rather than edited there. */
const C_SOURCE_ = 6;

function catchUpReminders() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_ORDERS);
  if (!sh) throw new Error('No "' + SHEET_ORDERS + '" sheet found.');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return log_('no orders yet');

  // Running every few minutes means this must stay cheap. Only orders inside
  // CATCHUP_WINDOW_DAYS can qualify, and orders are appended in time order, so
  // reading the tail is enough — rescanning years of history on every run
  // would burn the daily script-runtime quota for nothing.
  const firstRow = Math.max(2, lastRow - SCAN_ROWS + 1);
  const values = sh.getRange(firstRow, 1, lastRow - firstRow + 1, 20).getValues();
  const rowOffset = firstRow;
  const remindItems = itemsNeedingReminder_();
  const cal = reminderCalendar_();
  const today = startOfToday_();
  const oldest = new Date(today.getTime() - CATCHUP_WINDOW_DAYS * 86400000);

  let created = 0, skipped = 0;
  const failures = [];

  for (var i = 0; i < values.length; i++) {
    const row = values[i];
    // Offset by where the scan window started, not by 2 — reading a tail slice
    // means index 0 is no longer sheet row 2, and getting this wrong would
    // stamp the Reminder flag onto an unrelated order.
    const rowNumber = i + rowOffset;

    if (!String(row[C_NO - 1] || '').trim()) continue;              // blank row
    if (isTrue_(row[C_REMINDER - 1])) continue;                     // already done
    if (!isTrue_(row[C_TRACK - 1])) continue;                       // not tracked

    // Dashboard-entered orders decided this themselves; never override them.
    const seller = String(row[C_SELLER - 1] || '').trim();
    if (seller.toLowerCase() !== CATCHUP_SELLER.toLowerCase()) continue;

    const item = String(row[C_ITEM - 1] || '').trim();
    if (remindItems.indexOf(item.toLowerCase()) === -1) continue;   // Zoom only

    const expiry = asDate_(row[C_EXPIRY - 1]);
    if (!expiry || expiry <= today) { skipped++; continue; }        // already lapsed

    // Outside the window the row is yours to control — leave it alone.
    const purchased = asDate_(row[C_DATE - 1]);
    if (purchased && purchased < oldest) { skipped++; continue; }

    // Start today when the purchase date has passed, so Calendar isn't filled
    // with occurrences that already happened.
    const seriesStart = (!purchased || purchased < today) ? today : purchased;

    var series = null;
    try {
      series = createSeries_(cal, {
        no: row[C_NO - 1],
        customer: String(row[C_CUSTOMER - 1] || '').trim(),
        item: item,
        duration: String(row[C_DURATION - 1] || '').trim(),
        email: String(row[C_EMAIL - 1] || '').trim(),
        source: String(row[C_SOURCE_ - 1] || '').trim(),
        start: seriesStart,
        until: expiry
      });
    } catch (err) {
      failures.push('row ' + rowNumber + ' (' + item + '): ' + err.message);
      continue;
    }

    // Commit the flag immediately rather than letting Apps Script batch it to
    // the end of the run. Spreadsheets occasionally times out on that final
    // flush, and an uncommitted flag means tomorrow's run sees this row as
    // still needing a reminder and creates a SECOND calendar series for the
    // same order. Flushing here keeps the event and its flag together.
    try {
      sh.getRange(rowNumber, C_REMINDER).setValue(true);
      SpreadsheetApp.flush();
      created++;
    } catch (err) {
      // The event exists but the sheet doesn't know. Say so loudly and name
      // the event, because the fix is manual: either tick Reminder on that row
      // or delete the event before the next run duplicates it.
      failures.push(
        'row ' + rowNumber + ' (' + item + '): calendar series WAS created ("' +
        series.getTitle() + '") but the Reminder flag could not be saved — ' +
        'tick it by hand to avoid a duplicate tomorrow. ' + err.message
      );
    }
  }

  log_('created ' + created + ', skipped ' + skipped +
       (failures.length ? ', failed ' + failures.length + ' — ' + failures.join(' | ') : ''));
}

/** Config items with the Reminder flag on, lowercased for comparison. */
function itemsNeedingReminder_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CONFIG);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() !== 'Item') continue;
    if (!isTrue_(rows[i][5])) continue;            // F = Reminder
    if (isTrue_(rows[i][4]) === false && String(rows[i][4]).trim() !== '') continue; // E = Active
    out.push(String(rows[i][1] || '').trim().toLowerCase());
  }
  return out;
}

function reminderCalendar_() {
  if (REMINDER_CALENDAR_ID) {
    const cal = CalendarApp.getCalendarById(REMINDER_CALENDAR_ID);
    if (cal) return cal;
    log_('WARNING: cannot open ' + REMINDER_CALENDAR_ID + ' — using the default calendar instead');
  }
  return CalendarApp.getDefaultCalendar();
}

/**
 * One recurring event every REMIND_EVERY_DAYS at REMIND_HOUR Myanmar time,
 * until the plan ends. Mirrors scheduleReminders_ in Code.gs, but targets a
 * named calendar rather than the script owner's default.
 */
function createSeries_(cal, o) {
  const dateStr = Utilities.formatDate(o.start, TZ_MM, 'yyyy-MM-dd');
  const start = Utilities.parseDate(dateStr + ' ' + REMIND_HOUR, TZ_MM, 'yyyy-MM-dd HH:mm');
  const end = new Date(start.getTime() + 30 * 60000);

  const untilStr = Utilities.formatDate(o.until, TZ_MM, 'yyyy-MM-dd');
  const until = Utilities.parseDate(untilStr + ' 23:59', TZ_MM, 'yyyy-MM-dd HH:mm');
  if (until <= start) throw new Error('plan ends before the first reminder');

  const rec = CalendarApp.newRecurrence()
    .addWeeklyRule().interval(REMIND_EVERY_DAYS / 7).until(until);

  const series = cal.createEventSeries(
    o.item + ' — ' + o.customer, start, end, rec,
    { description: [
        'Order No. ' + o.no,
        'Customer: ' + o.customer,
        'Email: ' + (o.email || '—'),
        // Where the customer came from, so you know whether to reply on
        // Telegram, TikTok or Viber without opening the sheet.
        'Source: ' + (o.source || '—'),
        'Plan: ' + o.item + ' · ' + o.duration,
        'Runs until: ' + untilStr
      ].join('\n') });

  // Fires before REMIND_HOUR, so it's seen ahead of the 8am slot.
  series.addPopupReminder(30);
  return series;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isTrue_(v) {
  if (v === true) return true;
  return String(v || '').trim().toUpperCase() === 'TRUE';
}

/** Sheet cells arrive as Date objects or as text in either DD/MM/YYYY or
 *  YYYY-MM-DD — the Desk genuinely uses both in the same row. */
function asDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return stripTime_(v);
  const s = String(v || '').trim();
  if (!s) return null;

  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

  return null;
}

function stripTime_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfToday_() {
  return stripTime_(new Date());
}

function log_(msg) {
  Logger.log('[catchUpReminders] ' + msg);
}
