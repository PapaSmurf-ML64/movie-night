const { ChannelType, ThreadAutoArchiveDuration } = require('discord.js');
const { setGuildConfig } = require('./guildConfig');

const ARCHIVE_THREAD_NAME = 'Archived Events';

function isThreadChannel(channel) {
  return Boolean(channel) && [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type);
}

async function resolveArchiveThread(guild, guildConfig) {
  if (guildConfig.archiveThreadId) {
    try {
      const existing = await guild.channels.fetch(guildConfig.archiveThreadId);
      if (isThreadChannel(existing)) return existing;
    } catch {}
  }

  if (!guildConfig.scheduleChannelId) {
    throw new Error('No schedule channel configured for archive thread resolution.');
  }

  let channel = guild.channels.cache.get(guildConfig.scheduleChannelId);
  if (!channel) channel = await guild.channels.fetch(guildConfig.scheduleChannelId);

  let thread = channel.threads.cache.find(
    t => t.name === ARCHIVE_THREAD_NAME && t.type === ChannelType.PublicThread
  );

  if (!thread) {
    thread = await channel.threads.create({
      name: ARCHIVE_THREAD_NAME,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: 'Archive completed movie events',
    });
  }

  if (thread?.id && guildConfig.archiveThreadId !== thread.id) {
    setGuildConfig(guild.id, { archiveThreadId: thread.id });
  }

  return thread;
}

module.exports = {
  resolveArchiveThread,
  isThreadChannel,
  ARCHIVE_THREAD_NAME,
};
