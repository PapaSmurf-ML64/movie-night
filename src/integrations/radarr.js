// Radarr v3 API: status lookup and adding movies
const { fetchJson } = require('./http');

const headers = apiKey => ({ 'X-Api-Key': apiKey });

// Returns available quality profiles and root folders (for the dashboard dropdowns)
async function testRadarr(guildId, { url, apiKey }) {
  const [status, profiles, folders] = await Promise.all([
    fetchJson(guildId, `${url}/api/v3/system/status`, { headers: headers(apiKey) }),
    fetchJson(guildId, `${url}/api/v3/qualityprofile`, { headers: headers(apiKey) }),
    fetchJson(guildId, `${url}/api/v3/rootfolder`, { headers: headers(apiKey) }),
  ]);
  return {
    version: status?.version || '',
    qualityProfiles: (profiles || []).map(p => ({ id: p.id, name: p.name })),
    rootFolders: (folders || []).map(f => f.path),
  };
}

// 'available' | 'downloading' | 'requested' | null (not in Radarr)
async function getRadarrStatus(guildId, { url, apiKey }, tmdbId) {
  const movies = await fetchJson(guildId, `${url}/api/v3/movie?tmdbId=${encodeURIComponent(tmdbId)}`, { headers: headers(apiKey) });
  const movie = (movies || [])[0];
  if (!movie) return null;
  if (movie.hasFile) return 'available';
  const queue = await fetchJson(guildId, `${url}/api/v3/queue?movieIds=${movie.id}`, { headers: headers(apiKey) }).catch(() => null);
  return (queue?.records || []).length ? 'downloading' : 'requested';
}

async function addRadarr(guildId, cfg, tmdbId) {
  const { url, apiKey } = cfg;
  if (!cfg.qualityProfileId || !cfg.rootFolder) throw new Error('Pick a Radarr quality profile and root folder on the dashboard first.');
  const movie = await fetchJson(guildId, `${url}/api/v3/movie/lookup/tmdb?tmdbId=${encodeURIComponent(tmdbId)}`, { headers: headers(apiKey) });
  if (!movie?.tmdbId) throw new Error('Radarr couldn\'t find that movie.');
  await fetchJson(guildId, `${url}/api/v3/movie`, {
    method: 'POST',
    headers: headers(apiKey),
    body: {
      ...movie,
      qualityProfileId: Number(cfg.qualityProfileId),
      rootFolderPath: cfg.rootFolder,
      monitored: true,
      addOptions: { searchForMovie: true },
    },
  });
}

module.exports = { testRadarr, getRadarrStatus, addRadarr };
