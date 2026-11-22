// Overseerr / Jellyseerr API (same v1 API): status lookup and requests
const { fetchJson } = require('./http');

const headers = apiKey => ({ 'X-Api-Key': apiKey });

// Seerr mediaInfo.status codes
const MEDIA_STATUS = { 1: 'unknown', 2: 'pending', 3: 'processing', 4: 'partial', 5: 'available' };

async function testSeerr(guildId, { url, apiKey }) {
  const status = await fetchJson(guildId, `${url}/api/v1/status`, { headers: headers(apiKey) });
  // /status is public; /auth/me proves the key works
  await fetchJson(guildId, `${url}/api/v1/auth/me`, { headers: headers(apiKey) });
  return { version: status?.version || '' };
}

// 'available' | 'processing' | 'pending' | 'partial' | 'unknown' | null (never requested)
async function getSeerrStatus(guildId, { url, apiKey }, tmdbId) {
  const movie = await fetchJson(guildId, `${url}/api/v1/movie/${tmdbId}`, { headers: headers(apiKey) });
  const code = movie?.mediaInfo?.status;
  return code ? MEDIA_STATUS[code] || 'unknown' : null;
}

async function requestSeerr(guildId, { url, apiKey }, tmdbId) {
  await fetchJson(guildId, `${url}/api/v1/request`, {
    method: 'POST',
    headers: headers(apiKey),
    body: { mediaType: 'movie', mediaId: Number(tmdbId) },
  });
}

module.exports = { testSeerr, getSeerrStatus, requestSeerr };
