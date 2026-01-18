// Entry point for the Movie Night Discord Bot
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Collection } = require('discord.js');
const { postOrUpdateSchedule, loadScheduleMessageId, saveScheduleMessageId } = require('./scheduleEmbed');
const { registerHandlers } = require('./commands');
const { getRSVPs, getAttendance } = require('./roles');
const { joinConfiguredVoiceChannel } = require('./voice');
const path = require('path');
const { logBot } = require('./logger');
const { DateTime } = require('luxon');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

// In-memory config for schedule time/channel (should be persisted in production)
let config = {
  scheduleChannelId: process.env.DEFAULT_SCHEDULE_CHANNEL_ID || null,
  eventTime: process.env.DEFAULT_EVENT_TIME || 'Saturday 20:00',
};

// Command registration
const commands = [
  new SlashCommandBuilder()
    .setName('addmovie')
    .setDescription('Add a movie to the schedule')
    .addStringOption(option =>
      option.setName('title').setDescription('Movie title(s), comma-separated for double feature').setRequired(true))
    .addStringOption(option =>
      option.setName('date').setDescription('Optional date for viewing (YYYY-MM-DD)').setRequired(false))
    .addBooleanOption(option =>
      option.setName('doublefeature').setDescription('Add as a double feature (multiple movies on the same day)').setRequired(false))
    .addIntegerOption(option =>
      option.setName('year').setDescription('Optional release year for TMDB search').setRequired(false)),
  new SlashCommandBuilder()
    .setName('startevent')
    .setDescription('Start the next scheduled movie event'),
  new SlashCommandBuilder()
    .setName('stopevent')
    .setDescription('Stop the current movie event'),
  new SlashCommandBuilder()
    .setName('refreshschedule')
    .setDescription('Refresh the posted schedule'),
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel for schedule posting')
    .addChannelOption(option =>
      option.setName('channel').setDescription('Channel to post schedule').setRequired(true)),
  new SlashCommandBuilder()
    .setName('seteventtime')
    .setDescription('Set the default event time (e.g., Saturday 20:00)')
    .addStringOption(option =>
      option.setName('time').setDescription('Event time').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reschedulemovie')
    .setDescription('Reschedule a movie by ID')
    .addIntegerOption(option =>
      option.setName('id').setDescription('Movie ID to reschedule').setRequired(true))
    .addStringOption(option =>
      option.setName('date').setDescription('New date (YYYY-MM-DD)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('rsvp')
    .setDescription('RSVP for the next movie night'),
  new SlashCommandBuilder()
    .setName('unrsvp')
    .setDescription('Remove yourself from the Movie Night role'),
  new SlashCommandBuilder()
    .setName('setschedulemsg')
    .setDescription('Set the message ID to use for the schedule (admin only)')
    .addStringOption(option =>
      option.setName('messageid').setDescription('Discord message ID').setRequired(true)),
].map(cmd => cmd.toJSON());

client.commands = new Collection();

// Configurable default voice channel and time
const DEFAULT_VOICE_CHANNEL_ID = process.env.DEFAULT_VOICE_CHANNEL_ID || null; // Set in .env
const DEFAULT_EVENT_TIME = process.env.DEFAULT_EVENT_TIME || 'Saturday 20:00'; // 8PM EST

// Store the schedule message ID for updating (persisted in file)
const scheduleMsgFile = path.join(__dirname, '../schedule-message-id.txt');

let scheduleMessageId = loadScheduleMessageId();

// Register all handlers
registerHandlers(client, config, DEFAULT_VOICE_CHANNEL_ID, DEFAULT_EVENT_TIME);

// Export RSVP/attendance for dashboard
module.exports.getRSVPs = getRSVPs;
module.exports.getAttendance = getAttendance;

// Log bot startup
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  logBot('Bot started');
  // Log invite link with permissions integer
  const inviteLink = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot+applications.commands&permissions=17912432782848`;
  console.log('Bot invite link (with correct permissions):', inviteLink);
  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Slash commands registered globally.');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

// Auto-archive events 2 hours after scheduled time
async function autoArchivePastEvents() {
  const schedule = require('./schedule');
  const now = new Date();
  const guildId = process.env.ADMIN_GUILD_ID;
  const upcoming = await schedule.getUpcomingSchedule(guildId);
  for (const event of upcoming) {
    if (!event.date) continue;
    // Use Luxon for DST-correct 8PM Eastern
    const eventDateEastern = DateTime.fromISO(event.date + 'T20:00:00', { zone: 'America/New_York' });
    const archiveTime = eventDateEastern.plus({ hours: 2 }).toUTC();
    if (DateTime.utc() > archiveTime) {
      // Archive the event
      await schedule.archiveEvent(event.id, archiveTime.toISODate(), guildId);
      logBot(`Auto-archived event ${event.title} (${event.id}) for guild ${guildId}`);
      // Post to Discord archive thread
      try {
        const { ChannelType, ThreadAutoArchiveDuration } = require('discord.js');
        const guild = await client.guilds.fetch(guildId);
        let channel = guild.channels.cache.get(config.scheduleChannelId);
        if (!channel) channel = await guild.channels.fetch(config.scheduleChannelId);
        const threadName = 'Archived Events';
        let thread = channel.threads.cache.find(t => t.name === threadName && t.type === ChannelType.PublicThread);
        if (!thread) {
          thread = await channel.threads.create({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
            reason: 'Archive completed movie events',
          });
        }
        await thread.send(`**${event.title}** was watched on ${archiveTime.toISODate()}.`);
      } catch (e) {
        logBot(`Failed to post to archive thread for event ${event.id}: ${e.message}`);
      }
      // Update the schedule message after archiving
      try {
        let channel = client.channels.cache.get(config.scheduleChannelId);
        if (!channel) channel = await client.channels.fetch(config.scheduleChannelId);
        await postOrUpdateSchedule(channel, guildId);
        logBot(`Schedule message updated after auto-archiving event ${event.title} (${event.id})`);
      } catch (e) {
        logBot(`Failed to update schedule message after auto-archiving event ${event.id}: ${e.message}`);
      }
    }
  }
}

// Run auto-archive every 10 minutes
setInterval(autoArchivePastEvents, 10 * 60 * 1000);

// Auto-join voice channel and trigger event at scheduled time
async function autoStartScheduledEvents() {
  const schedule = require('./schedule');
  const { joinConfiguredVoiceChannel } = require('./voice');
  const now = new Date();
  const guildId = process.env.ADMIN_GUILD_ID;
  const voiceChannelId = process.env.DEFAULT_VOICE_CHANNEL_ID;
  const upcoming = await schedule.getUpcomingSchedule(guildId);
  // Track which event dates have already had their ping sent this run
  global._pingedEventDates = global._pingedEventDates || new Set();
  for (const event of upcoming) {
    if (!event.date) continue;
    // Use Luxon for DST-correct 8PM Eastern
    const eventDateEastern = DateTime.fromISO(event.date + 'T20:00:00', { zone: 'America/New_York' });
    const eventDateUTC = eventDateEastern.toUTC();
    // Send ping 5 minutes before event, only once per date
    const pingTime = eventDateUTC.minus({ minutes: 5 });
    global._pingedEvents = global._pingedEvents || new Set();
    if (
      DateTime.utc() >= pingTime &&
      DateTime.utc() < eventDateUTC &&
      !global._pingedEvents.has(event.id) &&
      !global._pingedEventDates.has(event.date)
    ) {
      try {
        const guild = await client.guilds.fetch(guildId);
        let channel = guild.channels.cache.get(config.scheduleChannelId);
        if (!channel) channel = await guild.channels.fetch(config.scheduleChannelId);
        const moviegoersRole = guild.roles.cache.find(r => r.name === 'Moviegoers');
        let roleMention = moviegoersRole ? `<@&${moviegoersRole.id}>` : '@everyone';
        // Fetch all movies for this event date
        const movies = (await require('./schedule').getUpcomingSchedule(guildId)).filter(m => m.date === event.date);
        const tmdb = require('./tmdb');
        let sentMsg;
        if (movies.length === 0) {
          sentMsg = await channel.send(`${roleMention} Movie Night starts in 5 minutes!`);
          setTimeout(() => { sentMsg.delete().catch(() => {}); }, 60 * 60 * 1000);
        } else {
          const header = `${roleMention} Movie night is starting in 5 minutes and on the schedule for tonight is:`;
          const embeds = [];
          for (const movie of movies) {
            if (movie && movie.tmdb_id) {
              try {
                const tmdbData = await tmdb.getMovieDetails(movie.tmdb_id);
                embeds.push({
                  color: 0xFFD700,
                  title: `${tmdbData.title} (${tmdbData.release_date ? tmdbData.release_date.slice(0,4) : ''})`,
                  description: tmdbData.overview || '',
                  fields: [
                    { name: 'Genres', value: tmdbData.genres && tmdbData.genres.length ? tmdbData.genres.map(g => g.name).join(', ') : 'N/A', inline: true },
                    { name: 'User Rating', value: tmdbData.vote_average ? `${tmdbData.vote_average}/10` : 'N/A', inline: true }
                  ]
                });
              } catch {}
            }
          }
          sentMsg = await channel.send({ content: header, embeds });
          setTimeout(() => { sentMsg.delete().catch(() => {}); }, 60 * 60 * 1000);
        }
        logBot(`Sent 5-min pre-event ping for event date ${event.date} in channel ${config.scheduleChannelId}`);
      } catch (e) {
        logBot(`Failed to send 5-min pre-event ping for event ${event.id}: ${e.message}`);
      }
      global._pingedEvents.add(event.id);
      global._pingedEventDates.add(event.date);
    }
    // Join voice channel exactly at event start, only once
    global._startedEvents = global._startedEvents || new Set();
    if (DateTime.utc() >= eventDateUTC && DateTime.utc() < eventDateUTC.plus({ minutes: 1 }) && !global._startedEvents.has(event.id)) {
      try {
        const guild = await client.guilds.fetch(guildId);
        await joinConfiguredVoiceChannel(guild, voiceChannelId);
        logBot(`Joined voice channel for event ${event.title} (${event.id}) in guild ${guildId}`);
      } catch (e) {
        logBot(`Failed to join voice channel for event ${event.id}: ${e.message}`);
      }
      global._startedEvents.add(event.id);
    }
  }
}

// Run auto-start every 1 minute
setInterval(autoStartScheduledEvents, 60 * 1000);

client.login(process.env.DISCORD_TOKEN);

// In registerHandlers, wrap all command handlers and error handlers to log pertinent activity:
// Example:
// logBot(`Command: ${commandName} by ${interaction.user?.id || 'unknown'}`);
// logBot(`Error: ${err.message}`);
// logBot(`Schedule updated for guild ${guild_id}`);