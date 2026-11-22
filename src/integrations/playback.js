// Playback events from Plex webhooks (Plex Pass) or Tautulli, normalized and applied to tonight's event:
//   play/resume -> "Now playing" post (once per movie) + attendance for linked Plex users
//   watched     -> archive that movie right away (instead of waiting for the fallback timer)
const { DateTime } = require('luxon');
const schedule = require('../schedule');
const { db, run, all } = require('../schedule');
const { addAttendance } = require('../roles');
const { getEventSettings, eventStart } = require('../util');
const { getGuildConfig } = require('../guildConfig');
const { resolveArchiveThread } = require('../archiveThread');
const { logBot } = require('../logger');
const { setWatching, clearWatchingIfArchived } = require('../nickname');

db.run(`CREATE TABLE IF NOT EXISTS plex_links (
  guild_id TEXT NOT NULL,
  plex_user TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, plex_user)
)`);

// Playback counts toward an event from 1 hour before start until 6 hours after
const WINDOW_BEFORE_MIN = 60;
const WINDOW_AFTER_HOURS = 6;

let hooks = { client: null, findScheduleChannel: async () => null, refreshScheduleMessage: async () => {} };
function initPlayback(h) { hooks = { ...hooks, ...h }; }

// ---- Plex account <-> Discord user links (for attendance) ----
const linkPlexUser = (guildId, plexUser, discordId) =>
  run(`INSERT INTO plex_links (guild_id, plex_user, discord_id) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, plex_user) DO UPDATE SET discord_id = excluded.discord_id`,
  [guildId, plexUser.toLowerCase(), discordId]);

const unlinkPlexUser = (guildId, discordId) =>
  run(`DELETE FROM plex_links WHERE guild_id = ? AND discord_id = ?`, [guildId, discordId]);

async function discordIdForPlexUser(guildId, plexUser) {
  if (!plexUser) return null;
  const row = (await all(`SELECT discord_id FROM plex_links WHERE guild_id = ? AND plex_user = ?`, [guildId, plexUser.toLowerCase()]))[0];
  return row?.discord_id || null;
}

// The event date whose playback window contains now (today's, or last night's after midnight)
function activeWindowDate(guildId, now = DateTime.now()) {
  const settings = getEventSettings(guildId);
  const today = now.setZone(settings.zone);
  for (const d of [today, today.minus({ days: 1 })]) {
    const date = d.toISODate();
    const start = eventStart(date, settings);
    if (now >= start.minus({ minutes: WINDOW_BEFORE_MIN }) && now <= start.plus({ hours: WINDOW_AFTER_HOURS })) return date;
  }
  return null;
}

// Find the scheduled movie this playback is for, if any
async function matchScheduledMovie(guildId, date, { tmdbId, title, year }) {
  const movies = (await schedule.getUpcomingSchedule(guildId)).filter(m => m.date === date);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return movies.find(m => tmdbId && String(m.tmdb_id) === String(tmdbId)) ||
    movies.find(m => norm(m.title) === norm(title) && (!year || !m.release_date || m.release_date.startsWith(String(year)))) ||
    null;
}

async function postToScheduleChannel(guildId, content) {
  const guild = hooks.client?.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = await hooks.findScheduleChannel(guild, getGuildConfig(guildId));
  if (channel) await channel.send(content);
}

async function archiveWatched(guildId, date, movie) {
  await schedule.archiveEvent(movie.id, date, guildId);
  logBot(`Archived ${movie.title} (${movie.id}) for guild ${guildId} after playback finished`);
  const guild = hooks.client?.guilds.cache.get(guildId);
  if (guild) {
    resolveArchiveThread(guild, getGuildConfig(guildId))
      .then(thread => thread.send(`**${movie.title}** was watched on ${date}.`))
      .catch(e => logBot(`Failed to post archive message for ${movie.id}: ${e.message}`));
  }
  await hooks.refreshScheduleMessage(guildId).catch(e => logBot(`Schedule refresh failed for ${guildId}: ${e.message}`));
  if (guild) await clearWatchingIfArchived(guild, [movie.id]);
}

// event: { action: 'play'|'resume'|'pause'|'stop'|'watched', tmdbId, title, year, plexUser, source }
async function handlePlaybackEvent(guildId, event) {
  const date = activeWindowDate(guildId);
  if (!date) return { handled: false, reason: 'outside event window' };
  const movie = await matchScheduledMovie(guildId, date, event);
  if (!movie) return { handled: false, reason: 'not a scheduled movie' };

  if (event.action === 'play' || event.action === 'resume') {
    const discordId = await discordIdForPlexUser(guildId, event.plexUser);
    if (discordId) await addAttendance(guildId, date, discordId);
    const guild = hooks.client?.guilds.cache.get(guildId);
    if (guild) await setWatching(guild, movie); // follows the actual movie during double features
    const flag = `nowplaying:${movie.id}`;
    if (!(await schedule.hasEventFlag(guildId, date, flag))) {
      await schedule.setEventFlag(guildId, date, flag);
      const year = movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : '';
      await postToScheduleChannel(guildId, `🎬 Now playing: **${movie.title}**${year}`)
        .catch(e => logBot(`Failed to post now-playing for ${guildId}: ${e.message}`));
    }
    return { handled: true, action: 'playing', movie: movie.title };
  }

  if (event.action === 'watched') {
    await archiveWatched(guildId, date, movie);
    return { handled: true, action: 'archived', movie: movie.title };
  }
  return { handled: false, reason: `ignored action ${event.action}` };
}

// ---- Payload normalizers ----

const PLEX_ACTIONS = { 'media.play': 'play', 'media.resume': 'resume', 'media.pause': 'pause', 'media.stop': 'stop', 'media.scrobble': 'watched' };

// Plex webhook payload -> event (or null if irrelevant / from another server)
function fromPlexPayload(payload, expectedMachineId) {
  const action = PLEX_ACTIONS[payload?.event];
  const md = payload?.Metadata;
  if (!action || md?.type !== 'movie') return null;
  if (expectedMachineId && payload?.Server?.uuid && payload.Server.uuid !== expectedMachineId) return null;
  const tmdbGuid = (md.Guid || []).map(g => g.id).find(id => id?.startsWith('tmdb://'));
  return {
    source: 'plex',
    action,
    tmdbId: tmdbGuid ? tmdbGuid.slice('tmdb://'.length) : null,
    title: md.title,
    year: md.year,
    plexUser: payload?.Account?.title || null,
  };
}

const TAUTULLI_ACTIONS = { play: 'play', resume: 'resume', pause: 'pause', stop: 'stop', watched: 'watched' };

// Tautulli JSON (from the template shown on the dashboard) -> event
function fromTautulliPayload(body) {
  const action = TAUTULLI_ACTIONS[String(body?.action || '').toLowerCase()];
  if (!action || (body.media_type && body.media_type !== 'movie')) return null;
  return {
    source: 'tautulli',
    action,
    tmdbId: body.themoviedb_id || null,
    title: body.title,
    year: body.year,
    plexUser: body.username || body.user || null,
  };
}

// Tautulli webhook JSON body template users paste into Tautulli (all triggers)
const TAUTULLI_TEMPLATE = JSON.stringify({
  action: '{action}',
  media_type: '{media_type}',
  title: '{title}',
  year: '{year}',
  themoviedb_id: '{themoviedb_id}',
  username: '{username}',
}, null, 2);

module.exports = {
  initPlayback,
  handlePlaybackEvent,
  fromPlexPayload,
  fromTautulliPayload,
  linkPlexUser,
  unlinkPlexUser,
  activeWindowDate,
  TAUTULLI_TEMPLATE,
  WINDOW_AFTER_HOURS,
};
