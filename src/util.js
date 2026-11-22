// Utility functions
const { DateTime } = require('luxon');
function autoDelete(msg, scheduleMessageId) {
  if (!msg) return;
  if (msg.id && scheduleMessageId && msg.id === scheduleMessageId) return;
  setTimeout(() => {
    msg.delete().catch(() => {});
  }, 30 * 1000); // 30 seconds
}

// ---- Date helpers ----
// Event dates are stored as plain 'YYYY-MM-DD' calendar dates in the event timezone.
// All "when is the event" math goes through luxon in that zone, never the server's local time.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EVENT_TZ = process.env.EVENT_TIMEZONE || 'America/New_York';
const DEFAULT_EVENT_TIME = 'Saturday 20:00';
const UPCOMING_WEEKS = 12;

// "Saturday 20:00" / "fri 7:30pm" -> { weekday (0=Sun), hour, minute } or null
function parseEventTime(str) {
  const m = /^\s*([a-z]+)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(str || '');
  if (!m) return null;
  const weekday = WEEKDAYS.findIndex(d => d.startsWith(m[1].toLowerCase()) && m[1].length >= 3);
  let hour = Number(m[2]);
  const minute = Number(m[3] || 0);
  const ampm = m[4]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === 'pm' ? 12 : 0);
  }
  if (weekday < 0 || hour > 23 || minute > 59) return null;
  return { weekday, hour, minute };
}

// Canonical display form: "Saturday 20:00"
function formatEventTime({ weekday, hour, minute }) {
  return `${WEEKDAYS[weekday][0].toUpperCase()}${WEEKDAYS[weekday].slice(1)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// Event settings for a guild (falls back to Saturday 20:00 if the stored value is invalid)
function getEventSettings(guildId) {
  const { getGuildConfig } = require('./guildConfig');
  const parsed = parseEventTime(getGuildConfig(guildId).eventTime) || parseEventTime(DEFAULT_EVENT_TIME);
  return { ...parsed, zone: EVENT_TZ };
}

// luxon DateTime of the event start on a given date
function eventStart(dateStr, settings) {
  return DateTime.fromISO(dateStr, { zone: settings.zone }).set({ hour: settings.hour, minute: settings.minute });
}

// Next regular event date ('YYYY-MM-DD'): today if it's the event day and the start hasn't passed
function nextEventDate(settings, now = DateTime.now()) {
  const local = now.setZone(settings.zone);
  const today = local.toISODate();
  const daysAhead = (settings.weekday - (local.weekday % 7) + 7) % 7; // luxon weekday: 1=Mon..7=Sun
  if (daysAhead === 0 && local < eventStart(today, settings)) return today;
  return local.plus({ days: daysAhead || 7 }).toISODate();
}

// Regular event dates for the next `weeks` weeks (rolling, not cut off at year end)
function upcomingEventDates(settings, weeks = UPCOMING_WEEKS, now = DateTime.now()) {
  const first = DateTime.fromISO(nextEventDate(settings, now));
  return Array.from({ length: weeks }, (_, i) => first.plus({ weeks: i }).toISODate());
}

// Today's date in the event timezone
function todayStr(settings) {
  return DateTime.now().setZone(settings.zone).toISODate();
}

// Strict 'YYYY-MM-DD' check (rejects 2026-02-30 etc.)
function isValidDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && DateTime.fromISO(s).isValid;
}

// Validate a user-supplied event date; returns an error message or null
function validateEventDate(s, settings) {
  if (!isValidDateStr(s)) return `"${s}" isn't a valid date. Use YYYY-MM-DD, e.g. 2026-12-25.`;
  if (s < todayStr(settings)) return `${s} is in the past.`;
  return null;
}

// 'YYYY-MM-DD' -> "December 25"
function formatMonthDay(s) {
  const [, month, day] = s.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}

// Day of week (0=Sun) of a 'YYYY-MM-DD' string, timezone-independent
function dayOfWeek(s) {
  return DateTime.fromISO(s, { zone: 'utc' }).weekday % 7;
}

// Unix timestamp (seconds) for the event start on the given date, DST-aware
function eventUnixTimestamp(s, settings) {
  return eventStart(s, settings).toUnixInteger();
}

module.exports = {
  autoDelete,
  MONTHS,
  EVENT_TZ,
  parseEventTime,
  formatEventTime,
  getEventSettings,
  eventStart,
  nextEventDate,
  upcomingEventDates,
  todayStr,
  isValidDateStr,
  validateEventDate,
  formatMonthDay,
  dayOfWeek,
  eventUnixTimestamp,
};
