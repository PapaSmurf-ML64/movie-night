// Handles schedule embed creation and posting/updating
const schedule = require('./schedule');
const fs = require('fs');
const path = require('path');
const { buildScheduleMappings } = require('./scheduleUtils');

const scheduleMsgFile = path.join(__dirname, '../schedule-message-id.txt');

const SCHEDULE_MESSAGE_ID = process.env.SCHEDULE_MESSAGE_ID || null;

let scheduleMessageId = SCHEDULE_MESSAGE_ID || loadScheduleMessageId();

function loadScheduleMessageId() {
  try {
    if (fs.existsSync(scheduleMsgFile)) {
      const id = fs.readFileSync(scheduleMsgFile, 'utf8').trim();
      if (id) return id;
    }
  } catch {}
  return null;
}
function saveScheduleMessageId(id) {
  try {
    fs.writeFileSync(scheduleMsgFile, id, 'utf8');
  } catch {}
}
function setScheduleMessageId(id) {
  scheduleMessageId = id;
}

// Export a function to post or update the schedule message
async function postOrUpdateSchedule(channel, guild_id) {
  // Get all scheduled movies for this guild
  const scheduled = await schedule.getUpcomingSchedule(guild_id);
  // Build a list of all Saturdays (8PM) until the end of the year
  const now = new Date();
  let nextSaturday = new Date(now);
  nextSaturday.setHours(20, 0, 0, 0); // 8PM
  const day = nextSaturday.getDay();
  if (!(day === 6 && now < nextSaturday)) {
    const daysUntilSaturday = (6 - day + 7) % 7 || 7;
    nextSaturday.setDate(nextSaturday.getDate() + daysUntilSaturday);
  }
  const year = now.getFullYear();
  let saturdays = [];
  let d = new Date(nextSaturday);
  while (d.getFullYear() === year) {
    saturdays.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  // Add all special event dates (non-Saturdays) from the database
  const allDatesSet = new Set(saturdays.map(date => date.toISOString().slice(0, 10)));
  scheduled.forEach(m => {
    if (m.date && !allDatesSet.has(m.date)) {
      allDatesSet.add(m.date);
    }
  });
  const allDates = Array.from(allDatesSet).sort();
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Build movieByDate using shared utility
  const { movieByDate } = await buildScheduleMappings(scheduled, process.env.DISCORD_TOKEN);
  // Build plain text schedule
  let lines = [
    '# Upcoming Movie Nights'
  ];
  // Find the longest formatted date string for alignment
  let formattedDates = allDates.map(dateStr => {
    const date = new Date(dateStr);
    const month = months[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    // Find 2nd Sunday in March
    let march = new Date(Date.UTC(year, 2, 1));
    let secondSundayMarch = new Date(march);
    secondSundayMarch.setUTCDate(1 + ((7 - march.getUTCDay()) % 7) + 7); // 2nd Sunday
    // Find 1st Sunday in November
    let november = new Date(Date.UTC(year, 10, 1));
    let firstSundayNovember = new Date(november);
    firstSundayNovember.setUTCDate(1 + ((7 - november.getUTCDay()) % 7));
    // DST: if the *start* of the event is before the first Sunday in November, it's still daylight time
    let utcHour = 1; // 8PM -5 UTC (Standard)
    if (date < firstSundayNovember && date >= secondSundayMarch) {
      utcHour = 0; // 8PM -4 UTC (Daylight)
    }
    // 8PM local is either 0:00 or 1:00 UTC *next day*
    const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + 1, utcHour, 0, 0));
    const unixTimestamp = Math.floor(utcDate.getTime() / 1000);
    return `${month} ${day} @ <t:${unixTimestamp}:t>`;
  });
  // Use tabs for padding to align movie titles at the same position
  const maxDateLen = Math.max(...formattedDates.map(s => s.length));
  const minTitleCol = 40; // Increase minimum column for more space
  const titleCol = Math.max(maxDateLen + 2, minTitleCol);
  allDates.forEach((dateStr, i) => {
    let formattedDate = formattedDates[i];
    const movies = movieByDate[dateStr] || [];
    if (movies.length > 0) {
      const titles = movies.map(m => m.release_date ? `${m.title} (${m.release_date.slice(0,4)})` : m.title).join(', ');
      lines.push(`${formattedDate} — ${titles}`);
    }
  });
  const scheduleText = lines.join('\n');
  if (SCHEDULE_MESSAGE_ID) {
    scheduleMessageId = SCHEDULE_MESSAGE_ID;
  }
  if (scheduleMessageId) {
    try {
      const msg = await channel.messages.fetch(scheduleMessageId);
      await msg.edit(scheduleText);
      return msg;
    } catch {
      scheduleMessageId = null;
      saveScheduleMessageId('');
      // fall through to post new message
    }
  }
  // If no valid message, post a new one and save the ID
  const newMsg = await channel.send(scheduleText);
  if (!SCHEDULE_MESSAGE_ID) {
    scheduleMessageId = newMsg.id;
    saveScheduleMessageId(newMsg.id);
  }
  return newMsg;
}

module.exports = { postOrUpdateSchedule, loadScheduleMessageId, saveScheduleMessageId, setScheduleMessageId, scheduleMsgFile };
