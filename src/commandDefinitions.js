// Slash command definitions (shared by bot.js startup registration and refresh-commands.js)
const { SlashCommandBuilder, ChannelType } = require('discord.js');

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
    .setName('setvoicechannel')
    .setDescription('Set the default voice channel for auto-started events')
    .addChannelOption(option =>
      option.setName('channel').setDescription('Voice channel to join for events').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setadminrole')
    .setDescription('Set the admin role used for restricted bot commands')
    .addRoleOption(option =>
      option.setName('role').setDescription('Role that can run admin commands').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setarchivethread')
    .setDescription('Set the archive thread used for completed events')
    .addChannelOption(option =>
      option
        .setName('thread')
        .setDescription('Existing thread for archived event posts')
        .addChannelTypes(ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread)
        .setRequired(true)),
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
  new SlashCommandBuilder()
    .setName('linkplex')
    .setDescription('Link your Plex username so watching on Plex counts toward attendance')
    .addStringOption(option =>
      option.setName('username').setDescription('Your Plex username (as shown in Plex/Tautulli)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unlinkplex')
    .setDescription('Unlink your Plex username'),
].map(cmd => cmd.toJSON());

module.exports = { commands };
