// Schedule helpers shared by the bot commands, schedule message and dashboard
const { DateTime } = require('luxon');
const schedule = require('./schedule');
const { getEventSettings, nextEventDate } = require('./util');

// First regular event date (at or after the next one) with nothing scheduled
async function nextFreeEventDate(guild_id) {
  const takenDates = new Set((await schedule.getUpcomingSchedule(guild_id)).map(m => m.date));
  let date = nextEventDate(getEventSettings(guild_id));
  while (takenDates.has(date)) date = DateTime.fromISO(date).plus({ weeks: 1 }).toISODate();
  return date;
}

async function buildScheduleMappings(upcoming) {
  const movieByDate = {};
  const addedByByDate = {};
  for (const m of upcoming) {
    if (!m.date) continue;
    (movieByDate[m.date] ||= []).push({ title: m.title, release_date: m.release_date });
    (addedByByDate[m.date] ||= []).push(m.added_by || '');
  }
  return { movieByDate, addedByByDate, dashboardSchedule: upcoming };
}

module.exports = { buildScheduleMappings, nextFreeEventDate };
