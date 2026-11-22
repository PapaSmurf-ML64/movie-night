// Handles schedule embed creation and posting/updating
const schedule = require('./schedule');
const fs = require('fs');
const path = require('path');
const { buildScheduleMappings } = require('./scheduleUtils');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { eventUnixTimestamp, getEventSettings } = require('./util');

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
function saveScheduleMessageId(id, guild_id) {
  if (guild_id) {
    setGuildConfig(guild_id, { scheduleMessageId: id || null });
    return;
  }
  try {
    fs.writeFileSync(scheduleMsgFile, id, 'utf8');
  } catch {}
}
function setScheduleMessageId(id, guild_id) {
  if (guild_id) {
    setGuildConfig(guild_id, { scheduleMessageId: id || null });
    return;
  }
  scheduleMessageId = id;
}

// Export a function to post or update the schedule message
async function postOrUpdateSchedule(channel, guild_id) {
  // Get all scheduled movies for this guild
  const scheduled = await schedule.getUpcomingSchedule(guild_id);
  // Only dates with movies are shown, so just group scheduled movies by date
  const { movieByDate } = await buildScheduleMappings(scheduled);
  const settings = getEventSettings(guild_id);
  const lines = ['# Upcoming Movie Nights'];
  for (const dateStr of Object.keys(movieByDate).sort()) {
    const titles = movieByDate[dateStr]
      .map(m => m.release_date ? `${m.title} (${m.release_date.slice(0, 4)})` : m.title)
      .join(', ');
    // <t:…:F> = full weekday, date and time, rendered by Discord in each reader's own timezone
    lines.push(`<t:${eventUnixTimestamp(dateStr, settings)}:F> — ${titles}`);
  }
  const scheduleText = lines.join('\n');
  const guildConfig = getGuildConfig(guild_id);
  let messageId = guildConfig.scheduleMessageId || scheduleMessageId;
  if (SCHEDULE_MESSAGE_ID) {
    messageId = SCHEDULE_MESSAGE_ID;
  }
  if (messageId) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(scheduleText);
      return msg;
    } catch {
      messageId = null;
      if (guild_id) {
        setGuildConfig(guild_id, { scheduleMessageId: null });
      } else {
        scheduleMessageId = null;
        saveScheduleMessageId('');
      }
      // fall through to post new message
    }
  }
  // If no valid message, post a new one and save the ID
  const newMsg = await channel.send(scheduleText);
  if (!SCHEDULE_MESSAGE_ID) {
    if (guild_id) {
      setGuildConfig(guild_id, { scheduleMessageId: newMsg.id });
    } else {
      scheduleMessageId = newMsg.id;
      saveScheduleMessageId(newMsg.id);
    }
  }
  return newMsg;
}

module.exports = { postOrUpdateSchedule, loadScheduleMessageId, saveScheduleMessageId, setScheduleMessageId, scheduleMsgFile };
