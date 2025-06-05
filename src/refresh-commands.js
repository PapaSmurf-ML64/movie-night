// Force refresh Discord slash commands
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('addmovie')
    .setDescription('Add a movie to the schedule')
    .addStringOption(option =>
      option.setName('title').setDescription('Movie title').setRequired(true))
    .addStringOption(option =>
      option.setName('date').setDescription('Optional date for viewing (YYYY-MM-DD)').setRequired(false))
    .addBooleanOption(option =>
      option.setName('doublefeature').setDescription('Add as a double feature (multiple movies on the same day)').setRequired(false)),
  new SlashCommandBuilder().setName('startevent').setDescription('Start the next scheduled movie event'),
  new SlashCommandBuilder().setName('stopevent').setDescription('Stop the current movie event'),
  new SlashCommandBuilder().setName('refreshschedule').setDescription('Refresh the posted schedule'),
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
    .setName('removemovie')
    .setDescription('Remove a movie from the schedule by ID')
    .addIntegerOption(option =>
      option.setName('id').setDescription('Movie ID to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reschedulemovie')
    .setDescription('Reschedule a movie by ID')
    .addIntegerOption(option =>
      option.setName('id').setDescription('Movie ID to reschedule').setRequired(true))
    .addStringOption(option =>
      option.setName('date').setDescription('New date (YYYY-MM-DD)').setRequired(true)),
  new SlashCommandBuilder().setName('archivedevents').setDescription('List archived (watched) events'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Refreshing application (/) commands...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
