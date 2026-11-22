// Entry point for the Movie Night Discord Bot
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const { DateTime } = require('luxon');
const schedule = require('./schedule');
const { buildMovieEmbeds } = require('./tmdb');
const { postOrUpdateSchedule } = require('./scheduleEmbed');
const { registerHandlers } = require('./commands');
const { commands } = require('./commandDefinitions');
const { addAttendance } = require('./roles');
const { joinConfiguredVoiceChannel } = require('./voice');
const { logBot } = require('./logger');
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { resolveArchiveThread } = require('./archiveThread');
const { getEventSettings, eventStart, todayStr, dayOfWeek } = require('./util');
const { startVote, closeDueVotes } = require('./movieVote');
const { getIntegrations } = require('./integrations/store');
const { initPlayback } = require('./integrations/playback');
const { clearWatchingIfArchived } = require('./nickname');

const PING_DELETE_MS = 60 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

registerHandlers(client);

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  logBot('Bot started');
  const inviteLink = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot+applications.commands&permissions=17912499891712`;
  console.log('Bot invite link (with correct permissions):', inviteLink);
  try {
    await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN)
      .put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands registered globally.');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

async function resolveScheduleChannel(guild, guildConfig) {
  if (guildConfig.scheduleChannelId) {
    try {
      const channel = guild.channels.cache.get(guildConfig.scheduleChannelId) || await guild.channels.fetch(guildConfig.scheduleChannelId);
      if (channel?.isTextBased?.()) return channel;
    } catch {}
  }

  // Fallback: find the channel holding the schedule message (expensive; result is saved to config)
  const scheduleMessageId = guildConfig.scheduleMessageId;
  if (scheduleMessageId) {
    const channels = await guild.channels.fetch();
    for (const channel of channels.values()) {
      if (!channel?.isTextBased?.()) continue;
      try {
        await channel.messages.fetch(scheduleMessageId);
        if (guildConfig.scheduleChannelId !== channel.id) {
          setGuildConfig(guild.id, { scheduleChannelId: channel.id });
        }
        return channel;
      } catch {}
    }
  }

  return null;
}

// ---- Attendance: anyone in the event voice channel from 15 min before start to 3 hours after ----
const ATTENDANCE_BEFORE_MIN = 15;
const ATTENDANCE_AFTER_HOURS = 3;

// Today's event date if we're inside its attendance window, else null
async function activeEventDate(guildId) {
  const settings = getEventSettings(guildId);
  const date = todayStr(settings);
  const start = eventStart(date, settings);
  const now = DateTime.now();
  const inWindow = now >= start.minus({ minutes: ATTENDANCE_BEFORE_MIN }) && now <= start.plus({ hours: ATTENDANCE_AFTER_HOURS });
  return inWindow && await schedule.hasEventOn(guildId, date) ? date : null;
}

async function recordVoiceAttendance(guild, members) {
  const { voiceChannelId } = getGuildConfig(guild.id);
  if (!voiceChannelId) return;
  const date = await activeEventDate(guild.id);
  if (!date) return;
  await Promise.all(members.filter(m => !m.user.bot).map(m => addAttendance(guild.id, date, m.id)));
}

client.on('voiceStateUpdate', (oldState, newState) => {
  const { voiceChannelId } = getGuildConfig(newState.guild.id);
  if (!newState.member || !voiceChannelId || newState.channelId !== voiceChannelId || oldState.channelId === voiceChannelId) return;
  recordVoiceAttendance(newState.guild, [newState.member])
    .catch(e => logBot(`Failed to record attendance in guild ${newState.guild.id}: ${e.message}`));
});

const VOICE_JOIN_GRACE_MIN = 30; // join late (e.g. after a restart) up to this long after start

async function sendPreEventPing(guild, guildConfig, date, movies) {
  const channel = await resolveScheduleChannel(guild, guildConfig);
  if (!channel) {
    logBot(`Skipped 5-min pre-event ping for ${date} in guild ${guild.id}: no schedule channel configured or discoverable.`);
    return false;
  }
  const moviegoersRole = guild.roles.cache.find(r => r.name === 'Moviegoers');
  const roleMention = moviegoersRole ? `<@&${moviegoersRole.id}>` : '@everyone';
  const sentMsg = movies.length === 0
    ? await channel.send(`${roleMention} Movie Night starts in 5 minutes!`)
    : await channel.send({
      content: `${roleMention} Movie night is starting in 5 minutes and on the schedule for tonight is:`,
      embeds: await buildMovieEmbeds(movies),
    });
  setTimeout(() => { sentMsg.delete().catch(() => {}); }, PING_DELETE_MS);
  logBot(`Sent 5-min pre-event ping for event date ${date} in channel ${channel.id}`);
  return true;
}

const roleMentionFor = guild => {
  const role = guild.roles.cache.find(r => r.name === 'Moviegoers');
  return role ? `<@&${role.id}>` : '@everyone';
};

const VOTE_LEAD_MIN = 30; // vote opens this long before start and closes at start

// Optional vote: on a regular event day with nothing scheduled, offer 5 Plex movies before start.
// (Opens any time in the window, so a restart during it still starts the vote late.)
async function maybeStartVote(guild, guildConfig, upcoming, now) {
  const settings = getEventSettings(guild.id);
  const date = todayStr(settings);
  if (dayOfWeek(date) !== settings.weekday || upcoming.some(m => m.date === date)) return;
  const start = eventStart(date, settings).toUTC();
  if (!(now >= start.minus({ minutes: VOTE_LEAD_MIN }) && now < start)) return;
  if (await schedule.hasEventFlag(guild.id, date, 'vote')) return;
  await schedule.setEventFlag(guild.id, date, 'vote');
  const channel = await resolveScheduleChannel(guild, guildConfig);
  if (!channel) return;
  try {
    await startVote(guild, channel, date, start, roleMentionFor(guild));
  } catch (e) {
    logBot(`Failed to start movie vote in guild ${guild.id}: ${e.message}`);
  }
}

async function processGuild(guild, now) {
  const guildId = guild.id;
  const guildConfig = getGuildConfig(guildId);
  // Count people already sitting in the voice channel during the event window (joins are caught by voiceStateUpdate)
  if (guildConfig.voiceChannelId) {
    const vc = guild.channels.cache.get(guildConfig.voiceChannelId);
    if (vc?.members?.size) await recordVoiceAttendance(guild, [...vc.members.values()]);
  }

  // Close any finished votes (winner gets scheduled), then maybe start tonight's vote
  try {
    if ((await closeDueVotes(guild, roleMentionFor(guild))).length) await refreshScheduleMessage(guildId);
  } catch (e) {
    logBot(`Failed to close movie vote in guild ${guildId}: ${e.message}`);
  }
  const upcoming = await schedule.getUpcomingSchedule(guildId);
  await maybeStartVote(guild, guildConfig, upcoming, now);
  if (upcoming.length === 0) return;

  // Group by date so double features are handled together
  const byDate = new Map();
  for (const event of upcoming) {
    if (event.date) (byDate.get(event.date) || byDate.set(event.date, []).get(event.date)).push(event);
  }

  const settings = getEventSettings(guildId);
  const integrations = await getIntegrations(guildId);
  const archiveAfterHours = integrations.plexWebhooks || integrations.tautulliWebhooks ? 6 : 2;
  let archivedAny = false;
  for (const [date, movies] of byDate) {
    const start = eventStart(date, settings).toUTC();

    // 5 minutes before start: ping once per date (persisted, so restarts don't re-ping)
    if (now >= start.minus({ minutes: 5 }) && now < start && !(await schedule.hasEventFlag(guildId, date, 'pinged'))) {
      try {
        if (await sendPreEventPing(guild, guildConfig, date, movies)) await schedule.setEventFlag(guildId, date, 'pinged');
      } catch (e) {
        logBot(`Failed to send 5-min pre-event ping for ${date} in guild ${guildId}: ${e.message}`);
      }
    }

    // At start: join the voice channel once
    if (now >= start && now < start.plus({ minutes: VOICE_JOIN_GRACE_MIN }) && !(await schedule.hasEventFlag(guildId, date, 'started'))) {
      await schedule.setEventFlag(guildId, date, 'started');
      if (guildConfig.voiceChannelId) {
        try {
          await joinConfiguredVoiceChannel(guild, guildConfig.voiceChannelId);
          logBot(`Joined voice channel for ${date} in guild ${guildId}`);
        } catch (e) {
          logBot(`Failed to join voice channel for ${date} in guild ${guildId}: ${e.message}`);
        }
      }
    }

    // Fallback archive (watched date = the event's calendar date). With playback webhooks the movie is
    // archived when it actually finishes, so the fallback waits much longer.
    if (now > start.plus({ hours: archiveAfterHours })) {
      let thread = null;
      try {
        thread = await resolveArchiveThread(guild, guildConfig);
      } catch (e) {
        logBot(`Failed to resolve archive thread for guild ${guildId}: ${e.message}`);
      }
      for (const event of movies) {
        await schedule.archiveEvent(event.id, date, guildId);
        archivedAny = true;
        logBot(`Auto-archived event ${event.title} (${event.id}) for guild ${guildId}`);
        if (thread) {
          await thread.send(`**${event.title}** was watched on ${date}.`)
            .catch(e => logBot(`Failed to post to archive thread for event ${event.id}: ${e.message}`));
        }
      }
      await clearWatchingIfArchived(guild, movies.map(m => m.id));
    }
  }

  // Update the schedule message once per guild after any archiving
  if (archivedAny) {
    try {
      const channel = await resolveScheduleChannel(guild, guildConfig);
      if (channel) {
        await postOrUpdateSchedule(channel, guildId);
        logBot(`Schedule message updated after auto-archiving in guild ${guildId}`);
      }
    } catch (e) {
      logBot(`Failed to update schedule message after auto-archiving in guild ${guildId}: ${e.message}`);
    }
  }
}

// Single scheduler tick: pings, voice auto-join and auto-archive
let tickRunning = false;
async function tick() {
  if (tickRunning || !client.isReady()) return; // don't overlap slow ticks
  tickRunning = true;
  const now = DateTime.utc();
  try {
    await Promise.all([...client.guilds.cache.values()].map(guild =>
      processGuild(guild, now).catch(e => logBot(`Scheduler error in guild ${guild.id}: ${e.message}`))));
  } finally {
    tickRunning = false;
  }
}

setInterval(tick, 60 * 1000);

client.login(process.env.DISCORD_TOKEN);

// Re-render a guild's posted schedule message (used by the dashboard after edits)
async function refreshScheduleMessage(guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = await resolveScheduleChannel(guild, getGuildConfig(guildId));
  if (channel) await postOrUpdateSchedule(channel, guildId);
}

initPlayback({ client, findScheduleChannel: resolveScheduleChannel, refreshScheduleMessage });

module.exports = { client, refreshScheduleMessage };
