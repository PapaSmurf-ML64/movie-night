// Posts or updates each guild's schedule message (message ID is stored per guild in guild-config.json)
const schedule = require('./schedule');
const { buildScheduleMappings } = require('./scheduleUtils');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { eventUnixTimestamp, getEventSettings } = require('./util');

function saveScheduleMessageId(id, guild_id) {
  setGuildConfig(guild_id, { scheduleMessageId: id || null });
}

async function postOrUpdateSchedule(channel, guild_id) {
  // Only dates with movies are shown, so just group scheduled movies by date
  const { movieByDate } = await buildScheduleMappings(await schedule.getUpcomingSchedule(guild_id));
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

  const { scheduleMessageId } = getGuildConfig(guild_id);
  if (scheduleMessageId) {
    try {
      const msg = await channel.messages.fetch(scheduleMessageId);
      await msg.edit(scheduleText);
      return msg;
    } catch {
      // Message gone or in another channel: post a new one below
    }
  }
  const newMsg = await channel.send(scheduleText);
  saveScheduleMessageId(newMsg.id, guild_id);
  return newMsg;
}

module.exports = { postOrUpdateSchedule, saveScheduleMessageId };
