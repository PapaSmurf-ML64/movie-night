// Plex Media Server API: connection test and "is this movie in the library?"
const { fetchJson } = require('./http');

const headers = token => ({ 'X-Plex-Token': token, 'X-Plex-Product': 'Movie Night Bot', 'X-Plex-Client-Identifier': 'movie-night-bot' });

// Returns { machineId, serverName } or throws
async function testPlex(guildId, { url, token }) {
  const data = await fetchJson(guildId, `${url}/identity`, { headers: headers(token) });
  // /identity doesn't require auth on some servers, so also hit an authed endpoint
  const sections = await fetchJson(guildId, `${url}/library/sections`, { headers: headers(token) });
  const movieSections = (sections?.MediaContainer?.Directory || []).filter(d => d.type === 'movie');
  if (!movieSections.length) throw new Error('Connected, but this server has no movie libraries.');
  const root = await fetchJson(guildId, `${url}/`, { headers: headers(token) }).catch(() => null);
  return {
    machineId: data?.MediaContainer?.machineIdentifier || '',
    serverName: root?.MediaContainer?.friendlyName || 'Plex',
    libraries: movieSections.map(s => s.title),
  };
}

// Find a movie by TMDB id (falling back to exact title + year). Returns { ratingKey, title } or null.
async function findPlexMovie(guildId, { url, token }, { tmdbId, title, year }) {
  const sections = await fetchJson(guildId, `${url}/library/sections`, { headers: headers(token) });
  const movieSections = (sections?.MediaContainer?.Directory || []).filter(d => d.type === 'movie');
  const wantGuid = `tmdb://${tmdbId}`;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const section of movieSections) {
    const q = `${url}/library/sections/${section.key}/all?type=1&includeGuids=1&title=${encodeURIComponent(title)}`;
    const items = (await fetchJson(guildId, q, { headers: headers(token) }))?.MediaContainer?.Metadata || [];
    const hit = items.find(m => (m.Guid || []).some(g => g.id === wantGuid)) ||
      items.find(m => norm(m.title) === norm(title) && (!year || String(m.year) === String(year)));
    if (hit) return { ratingKey: hit.ratingKey, title: hit.title };
  }
  return null;
}

// Every movie in the server's movie libraries (cached per guild; libraries can be large)
const LIBRARY_TTL = 6 * 60 * 60 * 1000;
const libraryCache = new Map(); // guildId -> { at, movies }

async function listPlexMovies(guildId, { url, token }) {
  const hit = libraryCache.get(guildId);
  if (hit && Date.now() - hit.at < LIBRARY_TTL) return hit.movies;
  const sections = await fetchJson(guildId, `${url}/library/sections`, { headers: headers(token) });
  const movieSections = (sections?.MediaContainer?.Directory || []).filter(d => d.type === 'movie');
  const movies = [];
  for (const section of movieSections) {
    const items = (await fetchJson(guildId, `${url}/library/sections/${section.key}/all?type=1&includeGuids=1`, { headers: headers(token) }))
      ?.MediaContainer?.Metadata || [];
    for (const m of items) {
      const tmdbGuid = (m.Guid || []).map(g => g.id).find(id => id?.startsWith('tmdb://'));
      movies.push({
        title: m.title,
        year: m.year || null,
        summary: m.summary || '',
        genres: (m.Genre || []).map(g => g.tag),
        tmdbId: tmdbGuid ? Number(tmdbGuid.slice('tmdb://'.length)) : null,
        ratingKey: m.ratingKey,
      });
    }
  }
  libraryCache.set(guildId, { at: Date.now(), movies });
  return movies;
}

module.exports = { testPlex, findPlexMovie, listPlexMovies };
