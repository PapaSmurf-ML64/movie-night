// Movie availability across a guild's Plex / Seerr / Radarr, and requesting missing movies.
const store = require('./store');
const { findPlexMovie } = require('./plex');
const { getSeerrStatus, requestSeerr } = require('./seerr');
const { getRadarrStatus, addRadarr } = require('./radarr');
const { logBot } = require('../logger');

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map(); // `${guildId}:${tmdbId}` -> { value, at }

// Display info per state
const STATES = {
  available: { emoji: '✅', label: 'On Plex' },
  downloading: { emoji: '⬇️', label: 'Downloading' },
  requested: { emoji: '🕓', label: 'Requested' },
  pending: { emoji: '🕓', label: 'Awaiting approval' },
  missing: { emoji: '⚠️', label: 'Not in library' },
  error: { emoji: '❔', label: 'Couldn\'t check' },
};

function describe(state, extra = {}) {
  return { state, ...STATES[state], ...extra };
}

async function hasAnyIntegration(guildId) {
  const i = await store.getIntegrations(guildId);
  return store.isPlexConfigured(i) || store.isSeerrConfigured(i) || store.isRadarrConfigured(i);
}

// Each source is checked independently: one unreachable service doesn't hide what the others report.
// Only if every configured source fails is the result 'error'.
async function checkAvailability(guildId, movie) {
  const i = await store.getIntegrations(guildId);
  const year = movie.release_date ? movie.release_date.slice(0, 4) : undefined;
  const errors = [];
  let checked = 0;
  const attempt = async (name, fn) => {
    try { checked++; return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return undefined; }
  };

  if (store.isPlexConfigured(i)) {
    const hit = await attempt('Plex', () => findPlexMovie(guildId, i.plex, { tmdbId: movie.tmdb_id, title: movie.title, year }));
    if (hit) return describe('available', { plexRatingKey: hit.ratingKey });
  }
  if (store.isSeerrConfigured(i)) {
    const s = await attempt('Seerr', () => getSeerrStatus(guildId, i.seerr, movie.tmdb_id));
    // Seerr says available but Plex didn't find it (or Plex isn't set up): trust Seerr
    if (s === 'available') return describe('available');
    if (s === 'processing' || s === 'partial') return describe('downloading');
    if (s === 'pending') return describe('pending');
  } else if (store.isRadarrConfigured(i)) {
    // Radarr is only consulted when Seerr isn't set up (Seerr already tracks Radarr)
    const r = await attempt('Radarr', () => getRadarrStatus(guildId, i.radarr, movie.tmdb_id));
    if (r) return describe(r === 'available' ? 'available' : r);
  }
  if (checked > 0 && errors.length === checked) return describe('error', { detail: errors.join(' · ') });
  return describe('missing', errors.length ? { detail: errors.join(' · ') } : {});
}

// Availability for a movie row ({ tmdb_id, title, release_date }); null if the guild has no integrations
async function getAvailability(guildId, movie, { fresh = false } = {}) {
  if (!movie?.tmdb_id || !(await hasAnyIntegration(guildId))) return null;
  const key = `${guildId}:${movie.tmdb_id}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  let value;
  try {
    value = await checkAvailability(guildId, movie);
  } catch (e) {
    value = describe('error', { detail: e.message });
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

// Request a movie via Seerr (preferred: it handles approval + Radarr) or Radarr directly.
// Returns { ok, message }.
async function requestMovie(guildId, movie) {
  const i = await store.getIntegrations(guildId);
  cache.delete(`${guildId}:${movie.tmdb_id}`);
  try {
    if (store.isSeerrConfigured(i)) {
      await requestSeerr(guildId, i.seerr, movie.tmdb_id);
      logBot(`Requested ${movie.title} (${movie.tmdb_id}) via Seerr for guild ${guildId}`);
      return { ok: true, message: `Requested ${movie.title} in Seerr.` };
    }
    if (store.isRadarrConfigured(i)) {
      await addRadarr(guildId, i.radarr, movie.tmdb_id);
      logBot(`Added ${movie.title} (${movie.tmdb_id}) to Radarr for guild ${guildId}`);
      return { ok: true, message: `Added ${movie.title} to Radarr and started a search.` };
    }
    return { ok: false, message: 'Set up Seerr or Radarr on the dashboard to request movies.' };
  } catch (e) {
    logBot(`Request for ${movie.tmdb_id} failed in guild ${guildId}: ${e.message}`);
    return { ok: false, message: `Request failed: ${e.message}` };
  }
}

// After a movie is added: check availability and auto-request if it's missing.
// Returns a short status line for the reply, or '' if the guild has no integrations.
async function afterMovieAdded(guildId, movie) {
  const availability = await getAvailability(guildId, movie, { fresh: true });
  if (!availability) return '';
  const i = await store.getIntegrations(guildId);
  if (availability.state === 'missing' && i.autoRequest && (store.isSeerrConfigured(i) || store.isRadarrConfigured(i))) {
    const result = await requestMovie(guildId, movie);
    return `${result.ok ? '🕓' : '⚠️'} ${movie.title}: ${result.message}`;
  }
  return `${availability.emoji} ${movie.title}: ${availability.label}`;
}

module.exports = { getAvailability, requestMovie, afterMovieAdded, hasAnyIntegration, STATES };
