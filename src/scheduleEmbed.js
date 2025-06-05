// Handles schedule embed creation and posting/updating
const schedule = require('./schedule');
const fs = require('fs');
const path = require('path');

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

async function postOrUpdateSchedule(channel) {
  const movies = await schedule.getUpcomingSchedule();
  const movieByDate = {};
  movies.forEach(m => {
    if (m.date) {
      if (!movieByDate[m.date]) movieByDate[m.date] = [];
      movieByDate[m.date].push(m.title);
    }
  });
  const now = new Date();
  let nextSaturday = new Date(now);
  nextSaturday.setHours(20, 0, 0, 0);
  const day = nextSaturday.getDay();
  if (!(day === 6 && now < nextSaturday)) {
    const daysUntilSaturday = (6 - day + 7) % 7 || 7;
    nextSaturday.setDate(nextSaturday.getDate() + daysUntilSaturday);
  }
  const year = now.getFullYear();
  let saturdays = [];
  let d = new Date(nextSaturday);
  while (d.getFullYear() === year && saturdays.length < 25) {
    saturdays.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Build plain text schedule
  let lines = [
    'Upcoming Movie Nights (all times 8:00 PM):'
  ];
  saturdays.forEach(date => {
    const dateStr = date.toISOString().slice(0, 10);
    const month = months[date.getMonth()];
    const day = date.getDate();
    const yearStr = date.getFullYear();
    const formattedDate = `${month} ${day}, ${yearStr}`;
    const titles = movieByDate[dateStr] ? movieByDate[dateStr].join(', ') : '<empty>';
    lines.push(`${formattedDate}: ${titles}`);
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
