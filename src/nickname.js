// Per-server "now watching" indicator via the bot's nickname (presence/status is global, nicknames are per guild).
// Driven only by playback webhooks (Plex/Tautulli "play"), never assumed from the schedule.
// The bot's previous nickname is saved in guild config and restored when that movie is archived or the event stops.
const { getGuildConfig, setGuildConfig } = require('./guildConfig');
const { logBot } = require('./logger');

const PREFIX = '🎬 ';
const MAX_NICK = 32; // Discord limit

function watchingNick(title) {
  const room = MAX_NICK - PREFIX.length;
  return PREFIX + (title.length > room ? title.slice(0, room - 1) + '…' : title);
}

async function setNick(guild, nick) {
  const me = guild.members.me || await guild.members.fetchMe();
  if (me.nickname === nick) return;
  await me.setNickname(nick, 'Movie night');
}

// Show "🎬 <title>" as the bot's nickname in this guild for the given scheduled movie
async function setWatching(guild, movie) {
  try {
    const config = getGuildConfig(guild.id);
    if (!config.watchingNickActive) {
      const me = guild.members.me || await guild.members.fetchMe();
      setGuildConfig(guild.id, { watchingNickActive: true, savedNickname: me.nickname || null });
    }
    setGuildConfig(guild.id, { watchingMovieId: movie.id });
    await setNick(guild, watchingNick(movie.title));
  } catch (e) {
    logBot(`Couldn't set watching nickname in guild ${guild.id} (needs "Change Nickname" permission): ${e.message}`);
  }
}

// Restore the bot's previous nickname (no-op if no event nickname is active)
async function clearWatching(guild) {
  const config = getGuildConfig(guild.id);
  if (!config.watchingNickActive) return;
  setGuildConfig(guild.id, { watchingNickActive: false, savedNickname: null, watchingMovieId: null });
  try {
    await setNick(guild, config.savedNickname || null);
  } catch (e) {
    logBot(`Couldn't restore nickname in guild ${guild.id}: ${e.message}`);
  }
}

// After movies are archived: restore the nickname if one of them is the movie currently shown.
// (The next movie of a double feature is shown when its own "play" webhook arrives.)
async function clearWatchingIfArchived(guild, archivedIds) {
  const { watchingNickActive, watchingMovieId } = getGuildConfig(guild.id);
  if (watchingNickActive && archivedIds.map(String).includes(String(watchingMovieId))) await clearWatching(guild);
}

module.exports = { setWatching, clearWatching, clearWatchingIfArchived };
