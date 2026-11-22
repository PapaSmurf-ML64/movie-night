// Voice channel join/stream logic
const { joinVoiceChannel, entersState, VoiceConnectionStatus, getVoiceConnection } = require('@discordjs/voice');

async function joinConfiguredVoiceChannel(guild, channelId) {
  if (!channelId) throw new Error('No default voice channel configured.');
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== 2) throw new Error('Configured channel is not a voice channel.');
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  return connection;
}

// Disconnect from voice in a guild; returns false if not connected
function leaveVoiceChannel(guildId) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return false;
  connection.destroy();
  return true;
}

module.exports = { joinConfiguredVoiceChannel, leaveVoiceChannel };
